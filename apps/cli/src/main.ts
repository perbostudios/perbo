#!/usr/bin/env node
import { COMMANDS } from "./command-line/table.js";
import { startEntryPoint } from "./command-line/terminal.js";

/**
 * `perbo` (docs/04, "Review CLI contract", SCP-091).
 *
 * The one entry point the binary is built from: the table says which commands
 * exist, `command-line/terminal.js` is the shell around it, and each command
 * reads its own line by the one grammar (D-NEW-cli-grammar).
 */
startEntryPoint(process.argv.slice(2), COMMANDS);
