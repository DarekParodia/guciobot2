import dotenv from 'dotenv';
const fs = require('fs');

import {DiscordBot} from './Discord';

async function main() {
  dotenv.config();
  DiscordBot.login(process.env.DISCORD_TOKEN!);
}
main();