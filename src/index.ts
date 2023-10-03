import OpenAI from "openai";
import fs from "fs";
import dotenv from "dotenv";
import * as readline from "node:readline";
import ora from "commonjs-ora";
import chalk from "chalk";

dotenv.config();

const success = chalk.bold.green;
const progress = chalk.bold.blue;
const info = chalk.bold.cyan;
const questionChalk = chalk.bold.yellow;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function prompt(question: string) {
  return new Promise<string>((resolve, reject) => {
    rl.question(questionChalk(question), (answer) => {
      resolve(answer);
    });
  });
}

const gpt3 = "gpt-3.5-turbo";
const gpt4 = "gpt-4";
const temperature = 0.5;
let tokenCounts: { [key: string]: number } = { [gpt3]: 0, [gpt4]: 0 };
const rateOf3 = 0.002 / 1000;
const rateOf4 = 0.06 / 1000;

const OPENAI_KEY = process.env.OPENAI_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_KEY,
});

interface MessageType {
  role: "user" | "assistant";
  content: string;
}

async function generation(
  gptModel: string,
  messages: MessageType[]
): Promise<[string, number]> {
  const completion = await openai.chat.completions.create({
    model: gptModel,
    messages: messages,
    temperature: temperature,
  });
  const response = completion.choices[0].message.content;
  const tokens = completion.usage?.total_tokens || 0;

  tokenCounts[gptModel] += tokens;

  return [response || "", tokens];
}

function concatOutput(responses: string[]): string {
  let answerPrompt = "";
  for (let i = 0; i < responses.length; i++) {
    answerPrompt += `Answer Option ${i + 1}: ${responses[i]}\n\n`;
  }
  return answerPrompt;
}

async function initialOutput(
  userInput: string,
  outputs: number
): Promise<[string[], string]> {
  const initialPrompt = `Question. ${userInput}\nAnswer: Let's work this out in a step by step way to be sure we have the right answer:`;

  const promises = Array(outputs)
    .fill(undefined)
    .map((_, i) => {
      const loading = ora(
        `Generating answer #${progress(`${i + 1}/${outputs}`)}`
      ).start();

      return generation(gpt3, [{ role: "user", content: initialPrompt }]).then(
        (res) => {
          loading.clear();

          return res;
        }
      );
    });

  const results = await Promise.all(promises);

  const responses = results.map((item) => item[0]);
  // const tokens = results.map((item) => item[1]);

  return [responses, initialPrompt];
}

async function researcher(
  answers: string,
  initialPrompt: string,
  outputs: number
): Promise<MessageType[]> {
  const prompt = `You are a researcher tasked with investigating the ${outputs} response options provided. List the flaws and faulty logic of each answer option. Let's work this out in a step by step way to be sure we have all the errors:`;

  let messages: MessageType[] = [
    { role: "user", content: initialPrompt },
    { role: "assistant", content: answers },
    { role: "user", content: prompt },
  ];

  const [response, tokens] = await generation(gpt3, messages);
  messages.push({ role: "assistant", content: response });

  return messages;
}

async function resolver(
  messages: MessageType[],
  outputs: number
): Promise<string> {
  const prompt = `The previous responses are from the researcher. You are a resolver tasked with 1) finding which of the ${outputs} answer options the researcher thought was best 2) improving that answer, and 3) Printing the improved answer in full. Let's work this out in a step by step way to be sure we have the right answer: `;

  messages.push({ role: "user", content: prompt });
  const [response, tokens] = await generation(gpt4, messages);

  const data =
    `Messages:\n` +
    messages.map((m) => `${m.role}: ${m.content}`).join("\n") +
    `\n\nSmartGPT Final Answer:\n` +
    response;
  saveToFile(data);

  return response;
}

async function finalOutput(finalResponse: string): Promise<string> {
  const prompt = `Based on the following response, extract out only the improved response and nothing else. DO NOT include typical responses and the answer should only have the improved response: \n\n${finalResponse}`;
  const [response, tokens] = await generation(gpt3, [
    { role: "user", content: prompt },
  ]);

  return response;
}

function saveToFile(data: string, filenamePrefix = "question"): void {
  if (!fs.existsSync("conversations")) {
    fs.mkdirSync("conversations");
  }

  let suffix = 1;
  while (fs.existsSync(`conversations/${filenamePrefix}_${suffix}.txt`)) {
    suffix += 1;
  }

  fs.writeFileSync(
    `conversations/${filenamePrefix}_${suffix}.txt`,
    data,
    "utf-8"
  );
}

async function main(): Promise<void> {
  const validRange = [1, 2, 3, 4];
  let outputs = 0;

  while (!validRange.includes(outputs)) {
    outputs = parseInt(
      await prompt("Enter the # of outputs you want (1 to 4): ")
    );
  }

  const userInput = await prompt("Question: ");
  console.log(progress(`Process Starting`));

  const loading = ora(`Generating answers`).start();

  const [initialResponses, initialPrompt] = await initialOutput(
    userInput,
    outputs
  );
  const answers = concatOutput(initialResponses);

  loading.text = "Researching answers";
  const researcherResponse = await researcher(answers, initialPrompt, outputs);

  loading.text = "Resolving answers";
  const finalResponse = await resolver(researcherResponse, outputs);

  loading.text = "Finalizing";

  const totalCalc = tokenCounts[gpt3] * rateOf3 + tokenCounts[gpt4] * rateOf4;
  const totalCost = `$${totalCalc.toFixed(2)}`;

  console.log(info(`You used ${tokenCounts[gpt3]} gpt3.5 tokens`));
  console.log(info(`You used ${tokenCounts[gpt4]} gpt4 tokens`));
  console.log(info(`Total Cost: ${totalCost}`));

  const finalAnswer = await finalOutput(finalResponse);

  loading.clear();
  console.log(success(`Process Complete`));

  console.log(info(`Final Answer: \n\n${chalk.white(finalAnswer)}`));
}

main();
