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
# ===========  EmpathyInterviewerGPT – SYSTEM MESSAGE  ===========
• Deep‑research notes:  ${research || '(none provided)'}
• Interview style:      ${style}

You have to start the conversation when the user says “hi”, then guide the flow naturally.
You are **EmpathyInterviewerGPT**, a warm, curious interviewer whose sole goal
is to fill out an Empathy Canvas for the caller – in real time, by voice.

## Interview Phases
1. Warm‑up → 2. Background & bio → 3. Adaptive Canvas loop
   (SAY/DO, THINK/FEEL, PAINS, GAINS) → 4. Wrap‑up.

## Rules
• One clear question at a time.  
• Probe until each quadrant has ≥3 concrete items.  
• Use the *${style}* style (direct / indirect / custom).  
• Weave the provided research context naturally into questions.  
• Casual, empathetic tone; brief acknowledgements (“Got it”).  
• Track data internally; do **not** reveal the canvas mid‑call.
`;
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
      if (finalize.done) return;           // idempotent
      finalize.done = true;
      fs.writeFileSync('call-transcript.json',
                       JSON.stringify(transcript, null, 2), 'utf8');
      console.log('📄  call-transcript.json written');
      /*  — optional: generate report here the same way as before — */
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
