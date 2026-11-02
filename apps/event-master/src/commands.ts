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

const matrixCommand = new SlashCommandBuilder()
  .setName('matrix')
  .setNameLocalizations({ ru: 'судная_ночь' })
  .setDescription('Управление событием «Судная ночь — Перезагрузка Матрицы»')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Создать событие')
      .addStringOption((o) =>
        o.setName('title').setDescription('Название события').setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName('countdown_minutes')
          .setDescription('Длительность обратного отсчёта в минутах')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(525600),
      )
      .addStringOption((o) =>
        o
          .setName('signup_channel_id')
          .setDescription('ID текстового канала для сообщения регистрации')
          .setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName('duration_hours')
          .setDescription('Длительность в часах (по умолчанию 1224)')
          .setMinValue(1)
          .setMaxValue(8760),
      )
      .addIntegerOption((o) =>
        o
          .setName('max_jail_minutes')
          .setDescription('Максимальный настраиваемый срок заключения')
          .setMinValue(1)
          .setMaxValue(525600),
      )
      .addStringOption((o) =>
        o
          .setName('victory_rules')
          .setDescription('Настраиваемые условия победы (текст)'),
      )
      .addStringOption((o) =>
        o
          .setName('objectives')
          .setDescription('Настраиваемые цели фракций (текст)'),
      )
      .addIntegerOption((o) =>
        o
          .setName('max_prophet')
          .setDescription('Максимум участников с ролью Пророка')
          .setMinValue(1),
      )
      .addIntegerOption((o) =>
        o
          .setName('max_punishers')
          .setDescription('Максимум участников-Карателей')
          .setMinValue(1),
      )
      .addIntegerOption((o) =>
        o
          .setName('max_rebels')
          .setDescription('Максимум участников-Повстанцев')
          .setMinValue(1),
      )
      .addIntegerOption((o) =>
        o
          .setName('max_prisoners')
          .setDescription('Максимум участников-Заключённых')
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Назначить игровую роль участнику')
      .addStringOption((o) =>
        o.setName('event_id').setDescription('ID события').setRequired(true),
      )
      .addUserOption((o) =>
        o.setName('player').setDescription('Участник').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('role')
          .setDescription('Игровая роль')
          .setRequired(true)
          .addChoices(
            { name: 'Пророк', value: 'Prophet' },
            { name: 'Каратели', value: 'Punishers' },
            { name: 'Повстанцы', value: 'Rebels' },
            { name: 'Заключённые', value: 'Prisoners' },
          ),
      )
      .addStringOption((o) =>
        o.setName('faction').setDescription('Настраиваемая фракция'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Снять состояние и запустить событие')
      .addStringOption((o) =>
        o.setName('event_id').setDescription('ID события').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('pause')
      .setDescription('Приостановить событие')
      .addStringOption((o) =>
        o.setName('event_id').setDescription('ID события').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('resume')
      .setDescription('Продолжить событие')
      .addStringOption((o) =>
        o.setName('event_id').setDescription('ID события').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('emergency')
      .setDescription('Аварийно завершить и восстановить')
      .addStringOption((o) =>
        o.setName('event_id').setDescription('ID события').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('outcome')
          .setDescription('Зафиксированный результат')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('confirm')
          .setDescription('Для подтверждения введите: ОСТАНОВИТЬ')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('jail')
      .setDescription('Заключить участника (команда Карателей)')
      .addUserOption((o) =>
        o.setName('player').setDescription('Цель').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('reason').setDescription('Причина').setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName('duration_minutes')
          .setDescription('Срок, ограниченный настройкой события')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(525600),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unjail')
      .setDescription('Освободить участника (команда Повстанцев)')
      .addUserOption((o) =>
        o.setName('player').setDescription('Участник').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('mission_create')
      .setDescription('Создать миссию фракции')
      .addStringOption((o) =>
        o.setName('event_id').setDescription('ID события').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('title').setDescription('Название').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('description')
          .setDescription('Описание условий')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('faction')
          .setDescription('Фракция, для миссий повстанцев выберите «Повстанцы»')
          .setRequired(true)
          .addChoices({ name: 'Повстанцы', value: 'Rebels' }),
      )
      .addIntegerOption((o) =>
        o
          .setName('target_progress')
          .setDescription('Настроенная цель прогресса')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((o) =>
        o.setName('consequence').setDescription('Настраиваемое последствие'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('outcome')
      .setDescription('Записать результат события')
      .addStringOption((o) =>
        o.setName('event_id').setDescription('ID события').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('result').setDescription('Результат').setRequired(true),
      ),
  );
matrixCommand.addSubcommand((sub) =>
  sub
    .setName('list')
    .setDescription('Показать события и состояние восстановления'),
);

const matrixOptionNamesRu: Record<string, string> = {
  title: 'название',
  duration_hours: 'длительность_час',
  countdown_minutes: 'отсчёт_минут',
  prophet: 'пророк',
  punishers: 'каратели',
  rebels: 'повстанцы',
  prisoners: 'заключённые',
  max_jail_minutes: 'макс_заключение',
  victory_rules: 'условия_победы',
  objectives: 'цели_фракций',
  max_prophet: 'лимит_пророк',
  max_punishers: 'лимит_каратели',
  max_rebels: 'лимит_повстанцы',
  max_prisoners: 'лимит_заключённые',
  event_id: 'событие_id',
  signup_channel_id: 'канал_регистрации',
  player: 'игрок',
  role: 'игровая_роль',
  faction: 'фракция',
  outcome: 'результат',
  confirm: 'подтверждение',
  reason: 'причина',
  duration_minutes: 'срок_минут',
  description: 'описание',
  target_progress: 'цель_прогресса',
  consequence: 'последствие',
  amount: 'величина',
  result: 'итог',
};
const matrixSubcommands = matrixCommand.options as unknown as Array<{
  options?: Array<{
    name: string;
    setNameLocalizations: (localizations: { ru: string }) => unknown;
  }>;
}>;
for (const subcommand of matrixSubcommands) {
  for (const option of subcommand.options ?? []) {
    const localizedName = matrixOptionNamesRu[option.name];
    if (localizedName) option.setNameLocalizations({ ru: localizedName });
  }
}

const allCommands = [
  matrixCommand,
  command('panel', 'панель', 'Открыть приватную панель администратора'),
  command('ping', 'проверка', 'Проверить связь с ботом'),
  command('eventhelp', 'справка', 'Показать справку по Event Master'),
].filter((entry) => entry.name !== 'matrix');

export const commands = allCommands;
