/*********************************************************************
 *  generateReport.js
 *  Reads call-transcript.json  →  asks Chat Completions  →  saves
 *  call-report.json
 *********************************************************************/
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const { OPENAI_API_KEY, MODEL = 'gpt-4o-2024-05-13' } = process.env;
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

if (!fs.existsSync('call-transcript.json'))
  throw new Error('call-transcript.json not found – run the interview first');

const transcript = JSON.parse(fs.readFileSync('call-transcript.json','utf8'));
const modelFallback = ['gpt-4o-mini','gpt-4-turbo'];

const ask = async mdl => {
  const r = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${OPENAI_API_KEY}`},
    body:JSON.stringify({
      model:mdl,
      temperature:0.4,
      messages:[
        {role:'system',content:'You output concise JSON reports.'},
        {role:'user',content:`
Here is a JSON array with the full transcript:
${JSON.stringify(transcript)}

Context:
(founder burnout research)

Return ONE JSON object:
  interviewee_bio, empathy_canvas, gpt_insights, full_transcript
`}]
    })
  });
  if(!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
  const js = await r.json();
  return js.choices[0].message.content.trim();
};

let report=null;
for (const mdl of [MODEL,...modelFallback]) {
  try { console.log(`🛈 trying ${mdl}`); report = await ask(mdl); break; }
  catch(e){ console.error(`⚠️ ${mdl} failed: ${e.message}`); }
}

if(!report) throw new Error('All models failed – no report written');
fs.writeFileSync('call-report.json',report,'utf8');
console.log('✅ call-report.json written');
