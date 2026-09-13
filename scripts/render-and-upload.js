// Renders one queued Short as a text-forward motion-graphics video: 6-8
// scenes, each with its own narration and its own procedurally-generated
// animated gradient background (no stock footage, no external media API —
// nothing left to mismatch the article, because nothing is attempting to
// depict it literally anymore). Cut together with short crossfades. The
// first scene doubles as the opener (headline overlaid on it). Runs
// entirely on the Actions runner.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKER_URL = process.env.WORKER_URL;
const VOICERSS_KEY = process.env.VOICERSS_KEY;
const YT_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YT_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

const WORKDIR = '/tmp/render';
const XFADE = 0.4;
const FPS = 25;
const W = 1080, H = 1920;
fs.mkdirSync(WORKDIR, { recursive: true });

// Curated palette matching the app's own indigo/violet branding — cycles
// by scene index so consecutive scenes read as visually distinct without
// ever needing to depict anything literal.
const PALETTE = [
  [[30,27,75],   [139,92,246]],  // indigo -> violet
  [[30,58,95],   [56,189,248]],  // deep blue -> cyan
  [[91,33,182],  [236,72,153]],  // violet -> pink
  [[15,23,42],   [99,102,241]],  // slate -> indigo
  [[6,78,59],    [52,211,153]],  // deep teal -> emerald
  [[76,29,29],   [249,115,22]]   // maroon -> orange
];

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
  sh(`ffmpeg -y -i "${rawPath}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 "${outPath}"`);
  return outPath;
}

function getAudioDuration(audioPath) {
  const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`).toString().trim();
  return parseFloat(out);
}

// ---------- word timing within a single scene ----------
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

// ---------- procedurally-generated animated gradient background ----------
// Replaces the old Pexels-based fetch entirely. A diagonal two-color
// gradient (geq, per-pixel math — no external asset) with a slow
// continuous zoom (zoompan — the standard Ken Burns technique) applied to
// it. Same generation method every time, so there's no possibility of the
// cross-scene frame-rate mismatch that broke crossfading before.
function buildSceneBackground(idx, clipDur) {
  const [c1, c2] = PALETTE[idx % PALETTE.length];
  const gradPath = path.join(WORKDIR, `grad_${idx}.png`);
  sh(`ffmpeg -y -f lavfi -i "color=s=${W}x${H}:d=1" -vf "geq=r='${c1[0]}+(${c2[0]-c1[0]})*(X+Y)/(W+H)':g='${c1[1]}+(${c2[1]-c1[1]})*(X+Y)/(W+H)':b='${c1[2]}+(${c2[2]-c1[2]})*(X+Y)/(W+H)'" -frames:v 1 "${gradPath}"`);

  const totalFrames = Math.max(1, Math.round(clipDur * FPS));
  const zoomIncr = (0.08 / totalFrames).toFixed(6); // gentle ~8% drift over the whole clip
  const bgClip = path.join(WORKDIR, `bgclip_${idx}.mp4`);
  sh(`ffmpeg -y -loop 1 -i "${gradPath}" -vf "zoompan=z='min(zoom+${zoomIncr},1.08)':d=${totalFrames}:s=${W}x${H}:fps=${FPS}" -t ${clipDur} "${bgClip}"`);
  return bgClip;
}

// ---------- build one scene's clip: gradient background + captions (+ headline if scene 0) ----------
async function buildSceneClip(scene, idx, isFirst, headline) {
  const narrationRaw = sanitizeScript(scene.narration);
  const narrationPath = path.join(WORKDIR, `narr_${idx}.mp3`);
  await fetchNarration(narrationRaw, narrationPath);
  const sceneDur = getAudioDuration(narrationPath);

  const words = buildWordTimeline(narrationRaw, sceneDur);
  const assPath = path.join(WORKDIR, `cap_${idx}.ass`);
  fs.writeFileSync(assPath, buildAss(words));

  const clipDur = sceneDur + XFADE; // padded so the crossfade has real footage to blend with
  const bgClip = buildSceneBackground(idx, clipDur);

  // Headline written to a file and read via textfile= instead of inlined
  // as text='...' — ffmpeg's filter-string quoting is fragile with real
  // headlines (apostrophes, colons, dashes), and this sidesteps that
  // escaping problem entirely.
  let headlineFilter = '';
  if (isFirst) {
    const headlineFile = path.join(WORKDIR, `headline_${idx}.txt`);
    fs.writeFileSync(headlineFile, headline.replace(/\r?\n/g, ' '));
    headlineFilter = `,drawtext=font='DejaVu Sans Bold':textfile='${headlineFile}':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=180:line_spacing=10:box=1:boxcolor=black@0.45:boxborderw=18:enable='between(t,0,2.3)'`;
  }

  // Audio padded to match clipDur exactly (real narration + XFADE of
  // silence) — lets the crossfade blend cleanly without overlapping voices.
  const audioPadded = path.join(WORKDIR, `narr_pad_${idx}.mp3`);
  sh(`ffmpeg -y -i "${narrationPath}" -af "apad=pad_dur=${XFADE}" -t ${clipDur} "${audioPadded}"`);

  const clip = path.join(WORKDIR, `scene_${idx}.mp4`);
  sh(`ffmpeg -y -i "${bgClip}" -i "${audioPadded}" -vf "fps=${FPS},subtitles=${assPath}${headlineFilter}" -c:v libx264 -pix_fmt yuv420p -c:a aac "${clip}"`);

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

// ---------- assemble the final video ----------
async function renderVideo(item) {
  const scenes = (item.scenes && item.scenes.length)
    ? item.scenes
    : [{ narration: item.script }];

  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    console.log(`Building scene ${i + 1}/${scenes.length}: ${scenes[i].narration}`);
    clips.push(await buildSceneClip(scenes[i], i, i === 0, item.title));
  }

  if (clips.length === 1) {
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
      description: `${item.title}\n\n${item.url || ''}\n\n#CurrentAffairs #Shorts #India`,
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
