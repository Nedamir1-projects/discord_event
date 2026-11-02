import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type MessageCreateOptions,
} from 'discord.js';

type MessageContainer = {
  type: 17;
  accent_color: number;
  components: { type: 10; content: string }[];
};

type AnnouncementTemplate = { components: [MessageContainer] };
type CommandsTemplate = {
  components: [
    MessageContainer,
    {
      type: 1;
      components: {
        type: 2;
        label: string;
        emoji?: { name: string };
        url: string;
      }[];
    },
  ];
};

const assetsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../assets',
);
const announcementTemplate = JSON.parse(
  readFileSync(resolve(assetsPath, 'hunt-announcement-message.json'), 'utf8'),
) as AnnouncementTemplate;
const commandsTemplate = JSON.parse(
  readFileSync(resolve(assetsPath, 'hunt-signup-message.json'), 'utf8'),
) as CommandsTemplate;

function createContainer(template: MessageContainer): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(template.accent_color)
    .addTextDisplayComponents(
      ...template.components.map((component) =>
        new TextDisplayBuilder().setContent(component.content),
      ),
    );
}

export function buildHuntSignupMessage(eventId: string): MessageCreateOptions {
  const [, linksTemplate] = commandsTemplate.components;
  const buttons = linksTemplate.components.map((component) => {
    const button = new ButtonBuilder()
      .setLabel(component.label)
      .setStyle(ButtonStyle.Link)
      .setURL(component.url);
    if (component.emoji) button.setEmoji(component.emoji.name);
    return button;
  });
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`hunt-signup:${eventId}`)
      .setLabel('Участвовать')
      .setStyle(ButtonStyle.Success),
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      createContainer(announcementTemplate.components[0]),
      createContainer(commandsTemplate.components[0]),
      row,
    ],
  };
}
