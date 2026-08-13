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
    await completeQueueItem(item.id, false, null);
    process.exit(1); // fails the Action loudly so you get a GitHub email
  }
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
  const HIGHLIGHT = '&H4AD5FF'; // gold — ASS colour order is &HBBGGRR, not RRGGBB
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

// ---------- background media — India-only, video first then still image ----------
function extractKeywords(title) {
  const STOP = new Set(['the','a','an','of','on','in','to','for','and','with','by','from','is','are','was','were','released','launched','announced','report','said','says','new','govt','government','india','indian']);
  const words = title.replace(/["'“”‘’]/g,'').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w.toLowerCase()));
  const proper = words.filter(w => /^[A-Z]/.test(w));
  return (proper.length ? proper : words).slice(0,3).join(' ') || 'India government';
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function fetchBackground(title) {
  const query = `${extractKeywords(title)} India`; // "India" always appended, per what you asked for
  try {
    const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`, { headers: { Authorization: PEXELS_KEY } });
    const data = await res.json();
    const vid = data.videos?.[0];
    if (vid) {
      const file = vid.video_files.find(f => f.width <= f.height) || vid.video_files[0];
      if (file) {
        const bgPath = path.join(WORKDIR, 'bg.mp4');
        await downloadFile(file.link, bgPath);
        return { type: 'video', path: bgPath };
      }
    }
  } catch (e) { console.warn('Pexels video failed:', e.message); }
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`, { headers: { Authorization: PEXELS_KEY } });
    const data = await res.json();
    const photo = data.photos?.[0];
    if (photo) {
      const bgPath = path.join(WORKDIR, 'bg.jpg');
      await downloadFile(photo.src.large2x || photo.src.large, bgPath);
      return { type: 'image', path: bgPath };
    }
  } catch (e) { console.warn('Pexels image failed:', e.message); }
  return null; // caller falls back to a plain dark background, never a broken render
}

// ---------- assemble the final video ----------
async function renderVideo(item) {
  const audioPath = await fetchNarration(item.script);
  const duration = getAudioDuration(audioPath);
  const timeline = buildWordTimeline(item.script, duration);
  const assPath = path.join(WORKDIR, 'captions.ass');
  fs.writeFileSync(assPath, buildAss(timeline));

  const bg = await fetchBackground(item.title);
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

  // Intro title card: first frame of the same background, headline text, ~2.5s
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
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } // private, per your call — flip to public once you've checked quality
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

async function completeQueueItem(id, success, videoUrl) {
  await fetch(`${WORKER_URL}?mode=queue&action=complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, success, videoUrl })
  });
}

main().catch(err => { console.error(err); process.exit(1); });
