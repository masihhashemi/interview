/*************************************************************
 *  Empathy-Canvas Interviewer – hard-coded research   v1.4
 *  • Inbound Twilio call  → Whisper → GPT-4o Realtime
 *  • Saves call-transcript.json      (report generation optional)
 *  • Handles the timing race + sends streamSid so audio plays back
 *************************************************************/
import fs from 'fs';
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import { spawn } from 'child_process';

dotenv.config();
const { OPENAI_API_KEY, MODEL = 'gpt-4o-2024-05-13' } = process.env;
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ⬇ simple POST /context   { "research": "...", "style": "direct" }
let CURRENT_CONTEXT = { research: '', style: 'direct' };

fastify.post('/context', async (req, reply) => {
  const { research = '', style = 'direct' } = req.body || {};
  CURRENT_CONTEXT = { research, style };
  
  console.log('📝 context updated', CURRENT_CONTEXT);
  reply.send({ ok: true });
});



/* escape &,<,> for TwiML */
const xmlEscape = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* ─────  SYSTEM PROMPT  (← put your full prompt here) ───── */
const SYSTEM_MESSAGE = ({ research, style }) => `
╭────────────────────────────────── SYSTEM PROMPT ──────────────────────────────────╮
│ ROLE                                                                             │
│   You are **EmpathyAgent**, a warm, adaptive conversationalist who speaks to ONE  │
│   human over the phone (Twilio audio).                                            │
│                                                                                  │
│ PURPOSE                                                                           │
│   Hold a natural, rapport-building conversation that quietly gathers everything   │
│   needed to populate an **Empathy Canvas**.  The caller should feel like they     │
│   just had a good chat with an interested person—not an interrogation.            │
│                                                                                  │
│ RUNTIME INPUTS (never reveal)                                                     │
│ ───────────────────────────────────────────────────────────────────────────────── │
│   • ${{research}}                                                             │
│       – A multi-paragraph briefing that gives you:                                │
│         · the **domain / field** (e.g., health, sports, entrepreneurship)        │
│         · typical **personas** and roles you might meet                           │
│         · the overarching **problem space or challenge** being explored           │
│         · key vocabulary, events, or trends                                       │
│       – Think of it as the “world” in which this interview takes place.           │
│                                                                                  │
│       HOW TO USE IT                                                               │
│         1.  Skim it silently before speaking.  Absorb domain language,            │
│             typical situations, and suspected root challenges.                    │
│         2.  Let it DRIVE which topics you probe and how you phrase follow-ups—    │
│             choose metaphors, anecdotes, and terminology that feel native         │
│             to that field.                                                        │
│         3.  Do **not** quote or reference the text itself.  Instead, weave its    │
│             knowledge into organic, context-appropriate questions and empathy.    │
│                                                                                  │
│   • {{MAX_MINUTES}} = 20 minutes                     │
│                                                                                  │
│ INTERNAL CANVAS OBJECT (never spoken)                                             │
│ ───────────────────────────────────────────────────────────────────────────────── │
│   { "name":"", "bio":"", "see":"", "hear":"", "do":"",                            │
│     "think_feel":"", "pains":"", "gains":"",                                      │
│     "_conf":      { "<each slot>":0 },                                            │
│     "_why_depth": { "<each slot>":0 } }                                           │
│                                                                                  │
│   • '_conf' (0–1) – confidence/completeness.  Start 0.0; +0.3 for a concrete      │
│     new detail; +0.2 when caller elaborates or confirms; cap 1.0.                 │
│   • '_why_depth'  – how many motive/meaning layers you have dug (0-4).            │
│   • Update both after every caller turn inside '<!-- INTERNAL … -->' comments.    │
│                                                                                  │
│ CONVERSATION FLOW (conceptual guide)                                              │
│ ───────────────────────────────────────────────────────────────────────────────── │
│ 1⃣  Welcome & consent                                                             │
│ 2⃣  Rapport & background (≤ ~2 min) – learn who they are **within the domain**    │
│ 3⃣  First canvas sweep  (finish by ~10 min) – cover every slot using domain-aware │
│     open prompts.                                                                 │
│ 4⃣  Depth loops – indirect 5-Whys for unclear slots.                              │
│ 5⃣  Graceful wrap-up – when '_conf' targets met, info-gain stalls, fatigue, or    │
│     time cap.                                                                     │
│ 6⃣  Send:  ###EMPATHY_CANVAS###  {<full JSON canvas>}                             │
│                                                                                  │
│ STYLE PRINCIPLES                                                                  │
│   • Sound like two people sharing stories; let each answer steer the next prompt. │
│   • Mirror caller’s vocabulary, tone, energy—using terms natural to               │
│     {{DEEP_RESEARCH}}’s field.                                                    │
│   • One open question per turn, brief empathetic acknowledgements.                │
│   • Softly rephrase or pivot if caller stalls.                                    │
│   • Never mention “canvas”, “slots”, “five whys”, research docs, or internals.    │
│                                                                                  │
│ SAFETY                                                                            │
│   • Defer on medical / legal / financial advice (“I’m not a professional”).       │
│   • Respect any request to skip or end the call immediately.                      │
╰──────────────────────────────────────────────────────────────────────────────────╯
`
;
/* ─────────────────────────────────────────────────────────── */

const VOICE = 'alloy';
const PORT  = process.env.PORT || 5050;

/* ---------- Twilio webhook ---------- */
fastify.all('/incoming-call', (req, reply) => {
  console.log('✅ Twilio /incoming-call was triggered: ' + new Date().toISOString());
  const wsURL = `wss://${req.headers.host}/media-stream`;
  reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to your interviewer.</Say>
  <Connect><Stream url="${xmlEscape(wsURL)}" /></Connect>
</Response>`);
});

// Serve the generated report JSON
fastify.get('/call-report.json', (request, reply) => {
  try {
    const data = fs.readFileSync('call-report.json', 'utf8');
    reply.header('Content-Type', 'application/json').send(data);
  } catch (err) {
    reply.status(404).send({ error: 'Report not found' });
  }
});

// (Optional) Serve the transcript JSON
fastify.get('/call-transcript.json', (request, reply) => {
  try {
    const data = fs.readFileSync('call-transcript.json', 'utf8');
    reply.header('Content-Type', 'application/json').send(data);
  } catch (err) {
    reply.status(404).send({ error: 'Transcript not found' });
  }
});

/* ---------- Media stream ---------- */
fastify.register(async () => {
  fastify.get('/media-stream', { websocket:true }, (conn) => {
    console.log('🔗  caller connected');

    const transcript = [];
    let streamSid    = null;
    let openAiReady  = false;
    const pending    = [];

    /* -------- finalize: runs once when call ends -------- */
    const finalize = () => {
      if (finalize.done) return;        // ensure idempotent
      finalize.done = true;

      // 1️⃣  write raw transcript
      fs.writeFileSync(
        'call-transcript.json',
        JSON.stringify(transcript, null, 2),
        'utf8'
      );
      console.log('📄  call-transcript.json written');

      // 2️⃣  spawn report.js in a child process
      const child = spawn('node', ['report.js'], {
        cwd: process.cwd(),   // same directory
        stdio: 'inherit',     // pipe its logs to Azure log‑stream
        env: process.env      // pass OPENAI_API_KEY, etc.
      });

      child.on('exit', code =>
        console.log(`📑 report.js finished (exit ${code})`)
      );
    };

    /* -------- connect to OpenAI Realtime -------- */
    const oa = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      { headers:{
          Authorization:`Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta':'realtime=v1'
        }}
    );

    oa.once('open', () => {
      openAiReady = true;
      oa.send(JSON.stringify({
        type:'session.update',
        session:{
          turn_detection:{type:'server_vad'},
          input_audio_format:'g711_ulaw',
          input_audio_transcription:{model:'whisper-1'},
          output_audio_format:'g711_ulaw',
          voice:VOICE,
          instructions:SYSTEM_MESSAGE(CURRENT_CONTEXT),
          modalities:['text','audio'],
          temperature:0.8
        }
      }));
      pending.forEach(a =>
        oa.send(JSON.stringify({type:'input_audio_buffer.append',audio:a})));
      pending.length = 0;
    });

    oa.on('message', buf => {
      const e = JSON.parse(buf.toString());
      if (e.type==='conversation.item.input_audio_transcription.completed' && e.transcript)
        transcript.push({speaker:'user',text:e.transcript});
      if (e.type==='response.audio_transcript.done' && e.transcript)
        transcript.push({speaker:'assistant',text:e.transcript});
      if (e.type==='response.audio.delta' && e.delta && streamSid)
        conn.send(JSON.stringify({
          event:'media',
          streamSid,
          media:{payload:e.delta}
        }));
    });

    /* -------- Twilio → OpenAI -------- */
    conn.on('message', msg => {
      const d = JSON.parse(msg);
      if (d.event==='media') {
        if (openAiReady)
          oa.send(JSON.stringify({type:'input_audio_buffer.append',audio:d.media.payload}));
        else
          pending.push(d.media.payload);
      } else if (d.event==='start') {
        streamSid = d.start.streamSid;           // capture sid
      } else if (d.event==='stop') {
        conn.close();                            // trigger close
      }
    });

    conn.on('close', () => {
      finalize();
      if (oa.readyState === WebSocket.OPEN) oa.close();
    });

    oa.on('error', console.error);
  });
});

/* ---------- start server ---------- */
+ fastify.listen({ port: PORT, host: '0.0.0.0' }, err => {
  if(err) throw err;
  console.log(`🚀  Listening on port ${PORT}`);
});
