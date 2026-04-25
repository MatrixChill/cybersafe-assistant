require("dotenv").config({ path: "packages/api/.env" });
const { OpenAI } = require("openai");

const openai = new OpenAI({ 
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

async function run() {
  try {
    const completion = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "system", content: "test" }, { role: "user", content: "oi" }],
      temperature: 0.7,
      max_tokens: 500,
    });
    console.log("SUCCESS:", completion.choices[0].message.content);
  } catch (error) {
    console.error("ERROR:");
    console.error(error);
  }
}

run();
