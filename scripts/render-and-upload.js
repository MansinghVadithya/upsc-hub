// Renders one queued Short (word-by-word captions, India-only background,
// headline intro card) and uploads it to YouTube as 'private'. Runs
// entirely on the Actions runner — no browser involved, unlike the old
// ffmpeg.wasm approach that kept hanging.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKER_URL = process.env.WORKER_URL;
const VOICERSS_KEY = process.env.VOICERSS_KEY;
const PEXELS_KEY = process.env.PEXELS_KEY;
const YT_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YT_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

const WORKDIR = '/tmp/render';
fs.mkdirSync(WORKDIR, { recursive: true });

function sh(cmd) {
  console.log('$ ' + cmd);
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  const nextRes = await fetch(`${WORKER_URL}?mode=queue&action=next`);
  const next = await nextRes.json();
  if (!next.ready) {
    console.log('Nothing to do:', next.reason || 'not ready');
    return;
  }
  const item = next.item;
  console.log('Processing queue item:', item.id, item.title);

  try {
    const videoPath = await renderVideo(item);
    const videoUrl = await uploadToYouTube(videoPath, item);
    await completeQueueItem(item.id, true, videoUrl);
    console.log('Done:', videoUrl);
  } catch (err) {
    console.error('Render/upload failed:', err.message);
    await completeQueueItem(item.id, false, null, err.message);
    process.exit(1);
  }
}

// ---------- text cleanup, shared by narration AND captions so they always
// match exactly ----------
// Strips markdown emphasis characters that TTS engines read literally
// (VoiceRSS was audibly saying "underscore"), and groups bare numbers with
// commas so they're read as quantities ("two thousand") instead of digit
// by digit ("two zero zero zero") — VoiceRSS's number-reading only kicks
// in reliably with comma-grouped numerals.
function sanitizeScript(text) {
  return text
    .replace(/[*_~`]/g, '')
    .replace(/\b\d{4,}\b/g, m => Number(m).toLocaleString('en-IN'))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- narration audio ----------
async function fetchNarration(script) {
  const res = await fetch(`${WORKER_URL}?mode=tts&text=${encodeURIComponent(script)}&key=${encodeURIComponent(VOICERSS_KEY)}`);
  const data = await res.json();
  if (data.error) throw new Error('VoiceRSS: ' + data.error);
  const audioPath = path.join(WORKDIR, 'narration.mp3');
  fs.writeFileSync(audioPath, Buffer.from(data.audio, 'base64'));
  return audioPath;
}

function getAudioDuration(audioPath) {
  const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`).toString().trim();
  return parseFloat(out);
}

// ---------- word timing (character-proportional — same estimate approach as the live client, one level deeper: sentence -> word) ----------
function splitSentences(script) {
  return script.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean);
}

function buildWordTimeline(script, totalDuration) {
  const sentences = splitSentences(script);
  const sentenceChars = sentences.map(s => s.length);
  const totalChars = sentenceChars.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  const timeline = [];
  sentences.forEach((sentence, i) => {
    const sentDur = totalDuration * (sentenceChars[i] / totalChars);
    const words = sentence.split(/\s+/).filter(Boolean);
    const wordChars = words.map(w => w.length);
    const totalWordChars = wordChars.reduce((a, b) => a + b, 0) || 1;
    let wt = t;
    const wordTimes = words.map((w, wi) => {
      const wDur = sentDur * (wordChars[wi] / totalWordChars);
      const start = wt, end = wt + wDur;
      wt = end;
      return { word: w, start, end };
    });
    timeline.push({ words: wordTimes });
    t += sentDur;
  });
  return timeline;
}

// ---------- ASS captions, one word highlighted at a time, one line on screen ----------
function assTime(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;
}
function escapeAss(s) { return s.replace(/\\/g,'\\\\').replace(/\n/g,'\\N'); }

function buildAss(timeline) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans Bold,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,1,4,2,2,60,60,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const HIGHLIGHT = '&H4AD5FF';
  const WHITE = '&HFFFFFF';
  let lines = '';
  timeline.forEach(({ words }) => {
    words.forEach((w, wi) => {
      const textParts = words.map((ww, i2) =>
        i2 === wi ? `{\\c${HIGHLIGHT}}${escapeAss(ww.word)}{\\c${WHITE}}` : escapeAss(ww.word)
      ).join(' ');
      lines += `Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Default,,0,0,0,,${textParts}\n`;
    });
  });
  return header + lines;
}

// ---------- background media — category-based (matches the app's own
// guessGS/getUnsplashKw system), India-only, video first then still image ----------
function guessGS(text) {
  const t = text.toLowerCase();
  const tags = new Set();
  if (/economy|gdp|fiscal|budget|inflation|tax|finance|trade|fdi|monetary|banking|nbfc|sebi|market|bond/.test(t)) tags.add('Economy');
  if (/defence|military|army|navy|missile|drdo|terror/.test(t)) tags.add('Defence');
  if (/environment|climate|forest|pollution|biodiversity|carbon|emission|ramsar|weather|monsoon/.test(t)) tags.add('Environment');
  if (/agriculture|farmer|crop|msp|irrigation|kisan/.test(t)) tags.add('Agriculture');
  if (/space|isro|technology|innovation|digital|quantum|nuclear|artificial intelligence/.test(t)) tags.add('S&T');
  if (/constitution|parliament|election|court|lok sabha|rajya sabha|supreme court/.test(t)) tags.add('Polity');
  if (/governance|scheme|policy|ministry|government/.test(t)) tags.add('Governance');
  if (/health|vaccine|disease|ayushman|education|nep/.test(t)) tags.add('Social');
  if (/foreign|bilateral|treaty|summit|g20|international|mou/.test(t)) tags.add('IR');
  if (/disaster|ndma|flood|cyclone/.test(t)) tags.add('Disaster');
  return [...tags];
}

function categoryKeyword(gsTags, text) {
  const t = text.toLowerCase();
  if (gsTags.includes('Defence') || /missile|drdo|army|navy|defence/.test(t)) return 'military technology India defence';
  if (gsTags.includes('Economy') || /bank|rbi|sebi|budget|gdp|finance/.test(t)) return 'economy finance India banking';
  if (gsTags.includes('Environment') || /climate|forest|wildlife|carbon|weather|monsoon/.test(t)) return 'environment nature green India';
  if (gsTags.includes('S&T') || /isro|space|ai|digital|tech|science/.test(t)) return 'technology science innovation India';
  if (gsTags.includes('Polity') || /parliament|election|court|constitution/.test(t)) return 'parliament governance democracy India';
  if (gsTags.includes('IR') || /bilateral|summit|diplomacy|g20|foreign/.test(t)) return 'diplomacy world international India';
  if (gsTags.includes('Agriculture') || /farmer|crop|kisan|msp/.test(t)) return 'agriculture farming rural India';
  if (gsTags.includes('Social') || /health|education|scheme|welfare/.test(t)) return 'education health society India';
  return 'India government current affairs';
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function pexelsVideo(query) {
  const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`, { headers: { Authorization: PEXELS_KEY } });
  const data = await res.json();
  const vid = data.videos?.[0];
  if (!vid) return null;
  const file = vid.video_files.find(f => f.width <= f.height) || vid.video_files[0];
  if (!file) return null;
  const bgPath = path.join(WORKDIR, 'bg.mp4');
  await downloadFile(file.link, bgPath);
  return { type: 'video', path: bgPath };
}

async function pexelsImage(query) {
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`, { headers: { Authorization: PEXELS_KEY } });
  const data = await res.json();
  const photo = data.photos?.[0];
  if (!photo) return null;
  const bgPath = path.join(WORKDIR, 'bg.jpg');
  await downloadFile(photo.src.large2x || photo.src.large, bgPath);
  return { type: 'image', path: bgPath };
}

async function fetchBackground(title, script) {
  // Category-based query is the PRIMARY attempt now, not a fallback — a
  // coined scheme name (e.g. "Mission Mausam") rarely has real matching
  // stock footage, so Pexels fuzzy-matches on whatever generic word is
  // left (usually "India") and returns something unrelated, like a flag.
  // Topic keywords drawn from the article's actual content are much more
  // reliably photographable and relevant than the scheme's literal name.
  const gsTags = guessGS(title + ' ' + script);
  const query = categoryKeyword(gsTags, title + ' ' + script) + ' India';
  try {
    const v = await pexelsVideo(query);
    if (v) return v;
  } catch (e) { console.warn('Pexels video failed:', e.message); }
  try {
    const p = await pexelsImage(query);
    if (p) return p;
  } catch (e) { console.warn('Pexels image failed:', e.message); }
  return null; // caller falls back to a plain dark background, never a broken render
}

// ---------- assemble the final video ----------
async function renderVideo(item) {
  // Sanitized once, used for BOTH narration and captions, so what's heard
  // and what's shown always match exactly.
  const script = sanitizeScript(item.script);

  const audioPath = await fetchNarration(script);
  const duration = getAudioDuration(audioPath);
  const timeline = buildWordTimeline(script, duration);
  const assPath = path.join(WORKDIR, 'captions.ass');
  fs.writeFileSync(assPath, buildAss(timeline));

  const bg = await fetchBackground(item.title, script);
  const W = 1080, H = 1920;

  const mainBg = path.join(WORKDIR, 'main_bg.mp4');
  if (bg?.type === 'video') {
    sh(`ffmpeg -y -stream_loop -1 -i "${bg.path}" -t ${duration} -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" -an "${mainBg}"`);
  } else if (bg?.type === 'image') {
    sh(`ffmpeg -y -loop 1 -i "${bg.path}" -t ${duration} -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" "${mainBg}"`);
  } else {
    sh(`ffmpeg -y -f lavfi -i "color=c=0x0c0c16:s=${W}x${H}:d=${duration}" "${mainBg}"`);
  }

  const captioned = path.join(WORKDIR, 'main_captioned.mp4');
  sh(`ffmpeg -y -i "${mainBg}" -i "${audioPath}" -vf "eq=brightness=-0.08,subtitles=${assPath}" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${captioned}"`);

  const introBg = path.join(WORKDIR, 'intro_bg.png');
  sh(`ffmpeg -y -i "${mainBg}" -frames:v 1 "${introBg}"`);
  const introDur = 2.5;
  const safeTitle = item.title.replace(/'/g, "\\'").replace(/:/g, '\\:');
  const intro = path.join(WORKDIR, 'intro.mp4');
  sh(`ffmpeg -y -loop 1 -i "${introBg}" -t ${introDur} -f lavfi -i "anullsrc=r=44100:cl=stereo" -vf "scale=${W}:${H},eq=brightness=-0.25,drawtext=font='DejaVu Sans Bold':text='${safeTitle}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=12:box=1:boxcolor=black@0.35:boxborderw=20" -c:v libx264 -pix_fmt yuv420p -shortest "${intro}"`);

  const listPath = path.join(WORKDIR, 'concat.txt');
  fs.writeFileSync(listPath, `file '${intro}'\nfile '${captioned}'\n`);
  const finalPath = path.join(WORKDIR, 'final.mp4');
  sh(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${finalPath}"`);
  return finalPath;
}

// ---------- YouTube upload ----------
async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: YT_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('YouTube auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function uploadToYouTube(videoPath, item) {
  const accessToken = await getAccessToken();
  const metadata = {
    snippet: {
      title: `${item.title} #Shorts`.slice(0, 100),
      description: `${item.title}\n\n${item.url || ''}\n\n#UPSC #CurrentAffairs #Shorts`,
      categoryId: '25'
    },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false }
  };

  const boundary = 'upsc_hub_' + Date.now();
  const videoBuf = fs.readFileSync(videoPath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    videoBuf,
    Buffer.from(`\r\n--${boundary}--`)
  ]);

  const res = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  if (!data.id) throw new Error('YouTube upload failed: ' + JSON.stringify(data));
  return `https://youtube.com/shorts/${data.id}`;
}

async function completeQueueItem(id, success, videoUrl, error) {
  await fetch(`${WORKER_URL}?mode=queue&action=complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, success, videoUrl, error })
  });
}

main().catch(err => { console.error(err); process.exit(1); });
