import { SlashCommandBuilder } from 'discord.js';

const command = (
  name: string,
  russianName: string,
  description: string,
): SlashCommandBuilder =>
  new SlashCommandBuilder()
    .setName(name)
    .setNameLocalizations({ ru: russianName })
    .setDescription(description);

export const commands = [
  command('balance', 'баланс', 'Показать баланс конфет'),
  command('profile', 'профиль', 'Показать игровой профиль'),
  command('shop', 'магазин', 'Открыть каталог товаров'),
  command('race', 'раса', 'Посмотреть расы и выбрать одну кнопкой'),
  command('abilities', 'способности', 'Посмотреть способности своей расы'),
  command('leaderboard', 'рейтинг', 'Показать рейтинг игроков'),
  command('coin', 'монетка', 'Подбросить монетку на конфеты')
    .addStringOption((option) =>
      option
        .setName('side')
        .setNameLocalizations({ ru: 'сторона' })
        .setDescription('Выберите орла или решку')
        .setRequired(true)
        .addChoices(
          { name: 'Орёл', value: 'heads' },
          { name: 'Решка', value: 'tails' },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('stake')
        .setNameLocalizations({ ru: 'ставка' })
        .setDescription('Сколько конфет поставить')
        .setMinValue(1)
        .setMaxValue(1_000_000_000)
        .setRequired(true),
    ),
  command('ping', 'проверка', 'Проверить связь с ботом'),
  command(
    'bite',
    'укус',
    'Вампир: укусить игрока и похитить конфеты',
  ).addUserOption((option) =>
    option
      .setName('player')
      .setNameLocalizations({ ru: 'игрок' })
      .setDescription('Цель способности')
      .setDescriptionLocalizations({ ru: 'Игрок, на которого применить укус' })
      .setRequired(true),
  ),
  command(
    'curse',
    'проклятие',
    'Ведьма: наложить проклятие на игрока',
  ).addUserOption((option) =>
    option
      .setName('player')
      .setNameLocalizations({ ru: 'игрок' })
      .setDescription('Цель способности')
      .setDescriptionLocalizations({
        ru: 'Игрок, на которого наложить проклятие',
      })
      .setRequired(true),
  ),
  command(
    'possess',
    'вселение',
    'Призрак: временно вселиться в игрока',
  ).addUserOption((option) =>
    option
      .setName('player')
      .setNameLocalizations({ ru: 'игрок' })
      .setDescription('Цель способности')
      .setDescriptionLocalizations({ ru: 'Игрок, в которого вселиться' })
      .setRequired(true),
  ),
  command('hunt', 'охота', 'Событие «Ночь охоты: Битва за сладости»')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setNameLocalizations({ ru: 'статус' })
        .setDescription('Показать состояние события и босса'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('attack')
        .setNameLocalizations({ ru: 'атаковать' })
        .setDescription('Атаковать финального босса')
        .addStringOption((option) =>
          option
            .setName('action')
            .setNameLocalizations({ ru: 'действие' })
            .setDescription('Название действия из настроек боя')
            .setDescriptionLocalizations({
              ru: 'Название действия, заданное администратором',
            })
            .setRequired(true),
        ),
    ),
  command(
    'halloween',
    'хэллоуин',
    'Участвовать в событии «Проклятие Хэллоуина»',
  )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('story')
        .setNameLocalizations({ ru: 'история' })
        .setDescription('Прочитать следующую главу истории'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('riddles')
        .setNameLocalizations({ ru: 'загадки' })
        .setDescription('Выбрать загадку и ответить без ввода ID'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('quests')
        .setNameLocalizations({ ru: 'квесты' })
        .setDescription('Показать доступные квесты'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('role')
        .setNameLocalizations({ ru: 'роль' })
        .setDescription('Узнать свою секретную роль приватно'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('polls')
        .setNameLocalizations({ ru: 'голосования' })
        .setDescription('Показать открытые голосования'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('vote')
        .setNameLocalizations({ ru: 'голосовать' })
        .setDescription('Проголосовать в опросе через меню выбора'),
    ),
  command(
    'pumpkin',
    'тыква',
    'Найти одну из семи общих тыкв по ссылке на сообщение',
  ),
];
