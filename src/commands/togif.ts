import {AttachmentBuilder, SlashCommandBuilder} from 'discord.js';
import * as http from 'http';
import {IncomingMessage} from 'http';
import * as https from 'https';
import {spawn} from 'node:child_process';
import {log} from 'node:console';

import type {Command} from './types';

const MAX_ATTACHMENT_SIZE = 9.5 * 1000000;
const ACCEPTABLE_MARGIN = 1.0 * 1000000;
const BITS_PER_PIXEL = 8;

function estimateGifSize(
    width: number, height: number, bitsppx: number, Frames: number):
    number{return (width * height * bitsppx * Frames) / 8}

function getMaxPixels(bitsppx: number, Frames: number, TargetSize: number) {
  return ((64 * TargetSize) / Frames) / bitsppx
}

function downloadImage(imageUrl: string):
    Promise<Buffer> {
      const client = imageUrl.startsWith('https://') ? https : http;
      return new Promise<Buffer>((resolve, reject) => {
        client
            .get(
                imageUrl,
                (res: IncomingMessage) => {
                  const chunks: Buffer[] = [];

                  res.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                  });

                  res.on('end', () => {
                    console.log('Download Completed');
                    resolve(Buffer.concat(chunks));
                  });

                  res.on('error', reject);
                })
            .on('error', reject);
      });
    }

function getGif(
    inputBuffer: Buffer, FPS: number, width: number, colors: number):
    Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i',
          'pipe:0',
          '-filter_complex',
          `[0:v]fps=${FPS},scale=${
              width}:-1:flags=lanczos,split=2[main][palette];[palette]palettegen=max_colors=${
              colors}[colors];[main][colors]paletteuse`,
          '-f',
          'gif',
          'pipe:1',
        ]);

        const outputChunks: Buffer[] = [];

        ffmpeg.stdout.on('data', (chunk: Buffer) => {
          outputChunks.push(chunk);
        });

        ffmpeg.on('close', (code: number) => {
          if (code === 0) {
            resolve(Buffer.concat(outputChunks));
          } else {
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        });

        ffmpeg.on('error', reject);

        // Write the buffer into ffmpeg's stdin, then close it
        ffmpeg.stdin.write(inputBuffer);
        ffmpeg.stdin.end();
      });
    }

export const togif: Command = {
  data: new SlashCommandBuilder()
            .setName('togif')
            .setDescription('Generuje gifa ze zdjęcia bądź filmu')
            .addAttachmentOption(
                (option) =>
                    option.setRequired(true).setName('media').setDescription(
                        'Zdjecie lub filmik'))
            .addNumberOption(
                (option) => option.setRequired(false)
                                .setName('fps')
                                .setDescription(`Ile fps ma miec gif`)
                                .setMaxValue(30)
                                .setMinValue(5))

      ,
  execute: async (interaction) => {
    let attachment = interaction.options.getAttachment('media');
    let fps = interaction.options.getNumber('fps')

    if (!fps) {
      fps = 15;
    }

    if (!attachment || !attachment.width || !attachment.height) {
      await interaction.reply({
        content:
            `Sorki ale nie przeslales zdjecia albo cos zlego jest ze zdjeciem :((`,
        ephemeral: true
      });
      return;
    }

    if (attachment.contentType?.startsWith('image')) {
      fps = 1;
    }
    // console.log(attachment);

    // dobra oficjalny plan byl taki ze estymuje rozmiar gifa i dostosywuje
    // scaling aby zmiescil sie w 10mb ale trudno mi obliczyc kompresje wiec
    // uzyje bruteforca
    let duration = attachment.duration ? attachment.duration : (1 / fps);
    let maxpx = getMaxPixels(
        BITS_PER_PIXEL, Math.floor(fps * duration), MAX_ATTACHMENT_SIZE);
    let inputpx = attachment.height * attachment.width;
    let scalingFactor = maxpx / inputpx;

    console.log(`Scaling factor: ${scalingFactor}, inputPX: ${inputpx}, maxPX:
      ${maxpx}, duration: ${duration}`);


    // try downlaoding the image
    await interaction.deferReply();
    console.log('awaiting');

    try {
      let url = attachment.url;

      const imageData = await downloadImage(url);

      const maxTries = 10;
      let lowScale = 0;
      let highScale = 1;
      let targetScale = highScale;
      let tries = 0;
      let outputBuffer: Buffer<ArrayBufferLike>|null = null;

      while (tries < maxTries) {
        tries++;
        const width = Math.max(1, Math.floor(attachment.width * targetScale));
        let candidate: Buffer<ArrayBufferLike>;

        try {
          candidate = await getGif(imageData, fps, width, 2 ** BITS_PER_PIXEL);
        } catch (error) {
          console.error(
              `GIF generation failed at scale ${targetScale}:`, error);
          highScale = targetScale;
          targetScale = (lowScale + highScale) / 2;
          continue;
        }
        console.log(
            `GIF size search: try ${tries + 1}/${maxTries}, ` +
            `scale ${targetScale.toFixed(3)} ` +
            `(range ${lowScale.toFixed(3)}-${highScale.toFixed(3)})`);

        console.log(
            `Current size: ${(candidate.length / 1000000).toFixed(1)} MB`);


        if (candidate.length > MAX_ATTACHMENT_SIZE) {
          highScale = targetScale;
        } else {
          outputBuffer = candidate;
          lowScale = targetScale;

          const remainingBytes = MAX_ATTACHMENT_SIZE - candidate.length;
          if (remainingBytes <= ACCEPTABLE_MARGIN ||
              highScale - lowScale < 0.01) {
            break;
          }
        }

        targetScale = (lowScale + highScale) / 2;
      }

      if (!outputBuffer) {
        interaction.editReply('eror');
        return
      }

      interaction.editReply(`Gif Size: ${
          outputBuffer.length /
          1000000}MB, Input Size: ${imageData.length / 1000000}MB`);

      if (outputBuffer.length > MAX_ATTACHMENT_SIZE) {
        console.log('Za duze 3:');

      } else {
        console.log('Creating attachment');

        const replyAttachment = new AttachmentBuilder(
            outputBuffer, {name: `${attachment.name}.gif`});

        await interaction.editReply({files: [replyAttachment]})

        console.log('Attachment done');
      }

    } catch (e) {
      interaction.editReply('eror');
      console.log(e);
    }
  },
};
