#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  exportQuarkShareIndex,
  parseQuarkShareUrl,
  QuarkShareError,
} from "./quark-share.js";
import { toCsv } from "./formatters.js";

const args = process.argv.slice(2);

main(args).catch((error) => {
  if (error instanceof QuarkShareError) {
    console.error(`Error: ${error.message}`);
    if (process.env.DEBUG && error.details) {
      console.error(JSON.stringify(error.details, null, 2));
    }
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

async function main(argv) {
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "parse-url") {
    const url = argv[1];
    if (!url) {
      throw new QuarkShareError("Missing share URL");
    }

    console.log(JSON.stringify(parseQuarkShareUrl(url), null, 2));
    return;
  }

  if (command === "export") {
    await exportCommand(argv.slice(1));
    return;
  }

  throw new QuarkShareError(`Unknown command: ${command}`);
}

async function exportCommand(argv) {
  const shareUrl = argv[0];
  if (!shareUrl) {
    throw new QuarkShareError("Missing share URL");
  }

  const options = parseOptions(argv.slice(1));

  if (!options.confirmAuthorized) {
    throw new QuarkShareError("Remote indexing requires --confirm-authorized.");
  }

  const index = await exportQuarkShareIndex({
    shareUrl,
    passcode: options.passcode || "",
    maxDepth: Number(options.maxDepth ?? 0),
    recursive: !options.noRecursive,
  });

  const format = options.format || "json";
  const output =
    format === "csv"
      ? toCsv(index.items)
      : JSON.stringify(index, null, 2);

  if (options.out) {
    const outPath = resolve(options.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, output, "utf8");
    console.log(`Exported ${index.items.length} items: ${outPath}`);
  } else {
    console.log(output);
  }
}

function parseOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--confirm-authorized") {
      options.confirmAuthorized = true;
    } else if (arg === "--no-recursive") {
      options.noRecursive = true;
    } else if (arg === "--passcode") {
      options.passcode = argv[++index];
    } else if (arg === "--format") {
      options.format = argv[++index];
      if (!["json", "csv"].includes(options.format)) {
        throw new QuarkShareError("--format only supports json or csv");
      }
    } else if (arg === "--out") {
      options.out = argv[++index];
    } else if (arg === "--max-depth") {
      options.maxDepth = argv[++index];
      if (!Number.isInteger(Number(options.maxDepth)) || Number(options.maxDepth) < 0) {
        throw new QuarkShareError("--max-depth must be an integer greater than or equal to 0");
      }
    } else {
      throw new QuarkShareError(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node ./src/cli.js parse-url <quark-share-url>
  node ./src/cli.js export <quark-share-url> --confirm-authorized [options]

Options:
  --passcode <code>        Share passcode
  --format <json|csv>      Output format, defaults to json
  --out <path>             Output file path; prints to stdout when omitted
  --max-depth <number>     Recursive max depth, defaults to 0
  --no-recursive           Export only the current directory
  --confirm-authorized     Confirm that you are authorized to index the share link
`);
}
