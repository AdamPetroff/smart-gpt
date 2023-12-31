#!/usr/bin/env node

import OpenAI from "openai";
import fs from "fs";
import dotenv from "dotenv";
import * as readline from "node:readline";
import ora from "ora";
import chalk from "chalk";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";

dotenv.config();

const success = chalk.bold.green;
const progress = chalk.bold.blue;
const info = chalk.bold.cyan;
const error = chalk.bold.red;
const questionChalk = chalk.bold.yellow;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function randomizeTemperature(): number {
  let num = Math.random() * 0.4 + 0.3; // Generate number between 0.3 and 0.7

  return Math.round(num * 100) / 100; // Round to 2 decimal places
}

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
  messages: MessageType[],
  temperature?: number
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
    .map(async (_, i) => {
      const res = await generation(
        useGPT4Everywhere ? gpt4 : gpt3,
        [{ role: "user", content: initialPrompt }],
        i === 0 ? undefined : randomizeTemperature()
      );

      loading.text = `Generating answers ${progress(`${i + 1}/${outputs}`)}`;

      return res;
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

  const [response, tokens] = await generation(
    useGPT4Everywhere ? gpt4 : gpt3,
    messages
  );
  messages.push({ role: "assistant", content: response });

  return messages;
}

async function resolver(
  messages: MessageType[],
  outputs: number
): Promise<string> {
  const prompt = `The previous responses are from the researcher. You are a resolver tasked with 1) finding which of the ${outputs} answer options the researcher thought was best 2) improving that answer, and 3) Printing the improved answer in full (nothing else). Let's work this out in a step by step way to be sure we have the right answer: `;

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
  const modelToUse = useGPT4Everywhere ? gpt4 : gpt3;
  const [response, tokens] = await generation(modelToUse, [
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

const validRange = [1, 2, 3, 4];

const argv = await yargs(hideBin(process.argv))
  .option("question", {
    alias: "q",
    type: "string",
    description: "Ask a question",
  })
  .option("outputs", {
    alias: "o",
    type: "number",
    description: "Number of outputs",
    choices: validRange,
  })
  .option("gpt4", {
    type: "boolean",
    description: "Use GPT-4 for all tasks",
    default: false,
  }).argv;

const useGPT4Everywhere = argv.gpt4;

const outputsUserInput =
  argv.outputs ||
  (await prompt(
    "Enter the desired number of answer to be compared (1 to 4)(defaults to 3): "
  ));
let outputs = Number(outputsUserInput);

if (outputsUserInput === "") {
  outputs = 3;
} else {
  while (!validRange.includes(outputs)) {
    if (isNaN(outputs)) {
      console.log(error(`\nPlease enter a valid number`));
    }
    outputs = parseInt(
      await prompt("\nEnter the # of outputs you want (1 to 4): ")
    );
  }
}

const loading = ora(`Generating answers ${progress(`${0}/${outputs}`)}`);

let userInput = argv.question || (await prompt("Question: "));

console.log(progress(`\nProcess Starting`));

loading.start();

const [initialResponses, initialPrompt] = await initialOutput(
  userInput,
  outputs!
);
const answers = concatOutput(initialResponses);

loading.text = "Researching answers";
const researcherResponse = await researcher(answers, initialPrompt, outputs);

loading.text = "Picking the best answer";
const finalResponse = await resolver(researcherResponse, outputs);

loading.text = "Improving the answer";

const finalAnswer = await finalOutput(finalResponse);

loading.stop();
console.log(success(`\nProcess Complete`));

console.log(info(`\nFinal Answer: \n\n${chalk.white(finalAnswer)}`));

const totalCalc = tokenCounts[gpt3] * rateOf3 + tokenCounts[gpt4] * rateOf4;
const totalCost = `$${totalCalc.toFixed(2)}`;

console.log(info(`\nYou used ${tokenCounts[gpt3]} gpt3.5 tokens`));
console.log(info(`\nYou used ${tokenCounts[gpt4]} gpt4 tokens`));
console.log(info(`\nTotal Cost (approximate): ${totalCost}`));

process.exit(0);
