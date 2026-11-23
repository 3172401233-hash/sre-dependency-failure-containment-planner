#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { planContainment } from './planner.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/cli.js <scenario.json>');
  process.exit(2);
}

const scenario = JSON.parse(await readFile(file, 'utf8'));
const plan = planContainment(scenario);
console.log(JSON.stringify(plan, null, 2));
