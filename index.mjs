#!/usr/bin/env node

import { execSync } from "child_process";
import { program } from "commander";
import OpenAI from "openai";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default working hours per day
const DEFAULT_HOURS = 8;

// Path to credentials file at root level
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

// Helper to check if the day is a weekend
function isWeekend(date) {
  return date.getDay() === 0 || date.getDay() === 6; // Sunday = 0, Saturday = 6
}

// Format commit messages using OpenAI
async function formatCommitMessages(messages, openai) {
  const prompt = `You are an assistant that formats raw git commit messages into polished sentences for a timesheet. Format the following messages:\n\n${messages.join(
    "\n"
  )}\n\nFormat them into a concise list of well-structured sentences.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error calling OpenAI API:", error.message);
    return messages.join("\n");
  }
}

// Update Google Sheet with timesheet data
async function updateGoogleSheet(sheetId, data, auth) {
  const sheets = google.sheets({ version: "v4", auth });

  const values = [
    ["Date", "Worked Hours", "Logs", "Weekend"], // Header row
    ...data.map((row) => [row.Date, row["Worked Hours"], row.Logs, row.Weekend]),
  ];

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Sheet1", // Update the first sheet
      valueInputOption: "RAW",
      requestBody: {
        values,
      },
    });

    console.log("Google Sheet updated successfully!");
  } catch (error) {
    console.error("Error updating Google Sheet:", error.message);
  }
}

// Generate the timesheet
async function generateTimesheet(apiKey, author, sheetId) {
  if (!apiKey) {
    console.error("OpenAI API Key is required. Use the --apikey option.");
    process.exit(1);
  }

  if (!sheetId) {
    console.error("Google Sheet ID is required. Use the --sheetid option.");
    process.exit(1);
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`Google credentials JSON file not found at: ${CREDENTIALS_PATH}`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const openai = new OpenAI({ apiKey });

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const firstDay = `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`;

  // Fetch git logs filtered by author
  const gitLogCommand = `git log --since="${firstDay}" --author="${author}" --pretty=format:"%ad - %s" --date=short`;
  let logs;
  try {
    logs = execSync(gitLogCommand).toString().split("\n");
  } catch (error) {
    console.error("Error fetching git logs. Are you in a git repository?");
    process.exit(1);
  }

  // Process logs
  const dailyLog = {};
  logs.forEach((log) => {
    if (!log) return;
    const [date, ...messageParts] = log.split(" - ");
    const message = messageParts.join(" - ").trim();
    if (!dailyLog[date]) dailyLog[date] = [];
    dailyLog[date].push(message);
  });

  // Prepare data for the Google Sheet
  const timesheetData = [];
  let totalHours = 0;

  for (let i = 1; i <= 31; i++) {
    const currentDate = new Date(currentYear, currentMonth - 1, i);
    if (currentDate.getMonth() + 1 !== currentMonth) break;

    const dateStr = currentDate.toISOString().split("T")[0];
    const isHoliday = isWeekend(currentDate);

    const rawMessages = dailyLog[dateStr] || [];
    const formattedMessages = rawMessages.length
      ? await formatCommitMessages(rawMessages, openai)
      : "No logs";

    const hours = rawMessages.length > 0 && !isHoliday ? DEFAULT_HOURS : 0;
    totalHours += hours;

    timesheetData.push({
      Date: dateStr,
      "Worked Hours": hours,
      Logs: formattedMessages,
      "Weekend": isHoliday ? "Yes" : "No",
    });
  }

  // Update the Google Sheet
  await updateGoogleSheet(sheetId, timesheetData, auth);
}

// CLI Setup
program
  .name("git-timesheet")
  .description("Generate a timesheet from git logs")
  .version("1.0.0")
  .requiredOption("-k, --apikey <key>", "OpenAI API key for formatting commit messages")
  .requiredOption("-a, --author <name>", "Git author name to filter logs")
  .requiredOption("-s, --sheetid <id>", "Google Sheet ID to update")
  .action((options) => {
    generateTimesheet(options.apikey, options.author, options.sheetid);
  });

program.parse(process.argv);
