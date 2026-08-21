// Renders one queued Short as a CINEMATIC multi-scene video: 6-8 scenes,
// each with its own narration, its own Gemini-chosen background, and its
// own word-by-word captions — cut together with short crossfades. The
// first scene doubles as the opener (headline overlaid on it) rather than
// a separate static title card. Runs entirely on the Actions runner.

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
const XFADE = 0.4; // short crossfade, per your call
const W = 1080, H = 1920;
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

// ---------- text cleanup ----------
function sanitizeScript(text) {
  return text
    .replace(/[*_~`]/g, '')
    .replace(/\b\d{4,}\b/g, m => Number(m).toLocaleString('en-IN'))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- narration audio (per scene), loudness-normalized ----------
async function fetchNarration(text, outPath) {
  const res = await fetch(`${WORKER_URL}?mode=tts&text=${encodeURIComponent(text)}&key=${encodeURIComponent(VOICERSS_KEY)}`);
  const data = await res.json();
  if (data.error) throw new Error('VoiceRSS: ' + data.error);
  const rawPath = outPath.replace('.mp3', '_raw.mp3');
  fs.writeFileSync(rawPath, Buffer.from(data.audio, 'base64'));
  // loudnorm brings VoiceRSS's quiet output up to a normal broadcast/social
  // loudness target (-16 LUFS, YouTube/Spotify's own reference level) —
  // fixes the "too soft to listen to" complaint without risking the
  // clipping/distortion a blind volume multiply would cause.
  sh(`ffmpeg -y -i "${rawPath}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 "${outPath}"`);
  return outPath;
}

function getAudioDuration(audioPath) {
  const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`).toString().trim();
  return parseFloat(out);
}

// ---------- word timing within a single scene (character-proportional) ----------
function buildWordTimeline(sentence, totalDuration) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const wordChars = words.map(w => w.length);
  const totalChars = wordChars.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return words.map((w, i) => {
    const dur = totalDuration * (wordChars[i] / totalChars);
    const start = t, end = t + dur;
    t = end;
    return { word: w, start, end };
  });
}

// ---------- ASS captions for one scene ----------
function assTime(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;
}
function escapeAss(s) { return s.replace(/\\/g,'\\\\').replace(/\n/g,'\\N'); }

function buildAss(words) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans Bold,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,1,4,2,2,60,60,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const HIGHLIGHT = '&H4AD5FF';
  const WHITE = '&HFFFFFF';
  let lines = '';
  words.forEach((w, wi) => {
    const textParts = words.map((ww, i2) =>
      i2 === wi ? `{\\c${HIGHLIGHT}}${escapeAss(ww.word)}{\\c${WHITE}}` : escapeAss(ww.word)
    ).join(' ');
    lines += `Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Default,,0,0,0,,${textParts}\n`;
  });
  return header + lines;
}

// ---------- background media — Gemini gives a specific per-scene search
// phrase directly, no keyword-guessing needed; category fallback only if
// that specific search comes back empty ----------
function guessGS(text) {
  const t = text.toLowerCase();
  const tags = new Set();
  if (/economy|gdp|fiscal|budget|inflation|tax|finance|trade|fdi|monetary|banking|market/.test(t)) tags.add('Economy');
  if (/defence|military|army|navy|missile|drdo/.test(t)) tags.add('Defence');
  if (/environment|climate|forest|pollution|weather|monsoon/.test(t)) tags.add('Environment');
  if (/agriculture|farmer|crop|kisan/.test(t)) tags.add('Agriculture');
  if (/space|isro|technology|digital|science/.test(t)) tags.add('S&T');
  if (/parliament|election|court|constitution/.test(t)) tags.add('Polity');
  if (/health|education|scheme|welfare/.test(t)) tags.add('Social');
  return [...tags];
}
function categoryFallback(gsTags) {
  if (gsTags.includes('Defence')) return 'military India defence';
  if (gsTags.includes('Economy')) return 'economy finance India';
  if (gsTags.includes('Environment')) return 'environment nature India';
  if (gsTags.includes('S&T')) return 'technology science India';
  if (gsTags.includes('Polity')) return 'parliament governance India';
  if (gsTags.includes('Agriculture')) return 'agriculture farming India';
  if (gsTags.includes('Social')) return 'education health India';
  return 'India government current affairs';
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function pexelsVideo(query, dest) {
  const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`, { headers: { Authorization: PEXELS_KEY } });
  const data = await res.json();
  const vid = data.videos?.[0];
  if (!vid) return null;
  const file = vid.video_files.find(f => f.width <= f.height) || vid.video_files[0];
  if (!file) return null;
  await downloadFile(file.link, dest);
  return { type: 'video', path: dest };
}

async function pexelsImage(query, dest) {
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`, { headers: { Authorization: PEXELS_KEY } });
  const data = await res.json();
  const photo = data.photos?.[0];
  if (!photo) return null;
  await downloadFile(photo.src.large2x || photo.src.large, dest);
  return { type: 'image', path: dest };
}

async function fetchSceneBackground(visualPhrase, articleTitle, idx) {
  const query = `${visualPhrase} India`;
  const dest = path.join(WORKDIR, `bg_${idx}`);
  try {
    const v = await pexelsVideo(query, dest + '.mp4');
    if (v) return v;
  } catch (e) { console.warn(`Scene ${idx} Pexels video failed:`, e.message); }
  try {
    const p = await pexelsImage(query, dest + '.jpg');
    if (p) return p;
  } catch (e) { console.warn(`Scene ${idx} Pexels image failed:`, e.message); }
  // Specific visual phrase found nothing — fall back to a broad category
  // term rather than leaving this one scene as a plain color card.
  try {
    const fallbackQuery = categoryFallback(guessGS(articleTitle)) ;
    const v = await pexelsVideo(fallbackQuery, dest + '_fb.mp4');
    if (v) return v;
  } catch (e) { /* fall through to plain background */ }
  return null;
}

// ---------- build one scene's clip: background + captions (+ headline if scene 0) ----------
async function buildSceneClip(scene, idx, isFirst, headline) {
  const narrationRaw = sanitizeScript(scene.narration);
  const narrationPath = path.join(WORKDIR, `narr_${idx}.mp3`);
  await fetchNarration(narrationRaw, narrationPath);
  const sceneDur = getAudioDuration(narrationPath);

  const words = buildWordTimeline(narrationRaw, sceneDur);
  const assPath = path.join(WORKDIR, `cap_${idx}.ass`);
  fs.writeFileSync(assPath, buildAss(words));

  const bg = await fetchSceneBackground(scene.visual, headline, idx);

  // Padded by XFADE at the tail (no captions in the pad) so the crossfade
  // into the next scene has real footage to blend with instead of cutting
  // into the last word of this scene's narration.
  const clipDur = sceneDur + XFADE;
  const bgClip = path.join(WORKDIR, `bgclip_${idx}.mp4`);
  if (bg?.type === 'video') {
    sh(`ffmpeg -y -stream_loop -1 -i "${bg.path}" -t ${clipDur} -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" -an "${bgClip}"`);
  } else if (bg?.type === 'image') {
    sh(`ffmpeg -y -loop 1 -i "${bg.path}" -t ${clipDur} -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}" "${bgClip}"`);
  } else {
    sh(`ffmpeg -y -f lavfi -i "color=c=0x0c0c16:s=${W}x${H}:d=${clipDur}" "${bgClip}"`);
  }

  // Headline overlay only on scene 0 — this scene doubles as the opener,
  // no separate static title card.
  const headlineFilter = isFirst
    ? `,drawtext=font='DejaVu Sans Bold':text='${headline.replace(/'/g,"\\'").replace(/:/g,'\\:')}':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=180:line_spacing=10:box=1:boxcolor=black@0.45:boxborderw=18:enable='between(t,0,2.3)'`
    : '';

  // Audio padded to match clipDur exactly (real narration + XFADE of
  // silence) — this silence-into-next-speech overlap is what lets the
  // crossfade sound clean instead of blending two voices together.
  const audioPadded = path.join(WORKDIR, `narr_pad_${idx}.mp3`);
  sh(`ffmpeg -y -i "${narrationPath}" -af "apad=pad_dur=${XFADE}" -t ${clipDur} "${audioPadded}"`);

  const clip = path.join(WORKDIR, `scene_${idx}.mp4`);
  sh(`ffmpeg -y -i "${bgClip}" -i "${audioPadded}" -vf "eq=brightness=-0.08,subtitles=${assPath}${headlineFilter}" -c:v libx264 -pix_fmt yuv420p -c:a aac "${clip}"`);

  return { path: clip, duration: clipDur, contentDuration: sceneDur };
}

// ---------- chain scenes together with matching video (xfade) and audio (acrossfade) crossfades ----------
function buildCrossfadeGraph(n, durations) {
  let videoChain = '', audioChain = '';
  let vPrev = '0:v', aPrev = '0:a';
  let cum = durations[0];
  for (let i = 1; i < n; i++) {
    const offset = cum - XFADE;
    const vOut = i === n - 1 ? 'vout' : `v${i}`;
    const aOut = i === n - 1 ? 'aout' : `a${i}`;
    videoChain += `[${vPrev}][${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${vOut}];`;
    audioChain += `[${aPrev}][${i}:a]acrossfade=d=${XFADE}:c1=tri:c2=tri[${aOut}];`;
    vPrev = vOut; aPrev = aOut;
    cum += durations[i] - XFADE;
  }
  return { graph: videoChain + audioChain, totalDuration: cum };
}

// ---------- assemble the final cinematic video ----------
async function renderVideo(item) {
  // Backward-compatible: old-format items (single flat script, no scenes)
  // still render as one plain scene rather than erroring out.
  const scenes = (item.scenes && item.scenes.length)
    ? item.scenes
    : [{ narration: item.script, visual: 'India government building' }];

  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    console.log(`Building scene ${i + 1}/${scenes.length}: ${scenes[i].narration}`);
    clips.push(await buildSceneClip(scenes[i], i, i === 0, item.title));
  }

  if (clips.length === 1) {
    // Nothing to crossfade — just trim off the trailing pad and ship it.
    const finalPath = path.join(WORKDIR, 'final.mp4');
    sh(`ffmpeg -y -i "${clips[0].path}" -t ${clips[0].contentDuration} -c copy "${finalPath}"`);
    return finalPath;
  }

  const inputs = clips.map(c => `-i "${c.path}"`).join(' ');
  const { graph, totalDuration } = buildCrossfadeGraph(clips.length, clips.map(c => c.duration));
  const contentTotal = clips.reduce((a, c) => a + c.contentDuration, 0);
  const finalPath = path.join(WORKDIR, 'final.mp4');
  sh(`ffmpeg -y ${inputs} -filter_complex "${graph}" -map "[vout]" -map "[aout]" -t ${Math.min(totalDuration, contentTotal + XFADE)} -c:v libx264 -pix_fmt yuv420p -c:a aac "${finalPath}"`);
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
