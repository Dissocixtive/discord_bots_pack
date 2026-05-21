// index.js
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  Events,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Конфигурация из переменных окружения (файл .env)
const CONFIG = {
  TOKEN: process.env.TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  // Если указан CATEGORY_ID, он имеет приоритет; иначе используется CATEGORY_NAME для поиска/создания
  CATEGORY_ID: process.env.CATEGORY_ID,
  CATEGORY_NAME: process.env.CATEGORY_NAME || 'Приватные комнаты',
  VOICE_CREATE_NAME: process.env.VOICE_CREATE_NAME || 'создать [+]',
  TEXT_CONTROL_NAME: process.env.TEXT_CONTROL_NAME || 'настройка',
};

// Хранилище активных комнат: channelId -> { ownerId, channel }
const activeRooms = new Map();

client.once(Events.ClientReady, async () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);

  const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) {
    console.error('❌ Гильдия не найдена! Проверьте GUILD_ID в .env');
    process.exit(1);
  }

  // Проверяем, есть ли у бота право управлять каналами
  const botMember = guild.members.cache.get(client.user.id);
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    console.error('❌ У бота нет права "Управлять каналами" на этом сервере!');
    process.exit(1);
  }

  // Настройка категории и базовых каналов
  await setupChannels(guild);
});

/**
 * Находит или создаёт категорию, а также текстовый и голосовой каналы в ней.
 * Приоритет: если указан CATEGORY_ID, используем существующую категорию (не создаём новую).
 * Иначе ищем категорию по CATEGORY_NAME, если не найдена — создаём.
 */
async function setupChannels(guild) {
  console.log('🔧 Начинаем настройку каналов...');

  // 1. Определяем категорию
  let category;

  if (CONFIG.CATEGORY_ID) {
    console.log(`🔍 Поиск категории по ID: ${CONFIG.CATEGORY_ID}`);
    category = guild.channels.cache.get(CONFIG.CATEGORY_ID);
    if (!category) {
      console.error(`❌ Категория с ID ${CONFIG.CATEGORY_ID} не найдена!`);
      return;
    }
    if (category.type !== ChannelType.GuildCategory) {
      console.error(`❌ Канал с ID ${CONFIG.CATEGORY_ID} не является категорией!`);
      return;
    }
    console.log(`✅ Используется категория: ${category.name} (ID: ${category.id})`);
  } else {
    console.log(`🔍 Поиск категории по имени: "${CONFIG.CATEGORY_NAME}"`);
    category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === CONFIG.CATEGORY_NAME
    );
    if (!category) {
      console.log(`⚠️ Категория не найдена, создаём новую...`);
      try {
        category = await guild.channels.create({
          name: CONFIG.CATEGORY_NAME,
          type: ChannelType.GuildCategory,
        });
        console.log(`✅ Категория создана: ${category.name} (ID: ${category.id})`);
      } catch (error) {
        console.error(`❌ Ошибка при создании категории: ${error.message}`);
        return;
      }
    } else {
      console.log(`✅ Найдена существующая категория: ${category.name}`);
    }
  }

  // 2. Текстовый канал для управления
  console.log(`🔍 Поиск текстового канала "${CONFIG.TEXT_CONTROL_NAME}" в категории...`);
  let textChannel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === CONFIG.TEXT_CONTROL_NAME && c.parentId === category.id
  );
  if (!textChannel) {
    console.log(`⚠️ Текстовый канал не найден, создаём...`);
    try {
      textChannel = await guild.channels.create({
        name: CONFIG.TEXT_CONTROL_NAME,
        type: ChannelType.GuildText,
        parent: category.id,
      });
      console.log(`✅ Текстовый канал создан: ${textChannel.name}`);
    } catch (error) {
      console.error(`❌ Ошибка при создании текстового канала: ${error.message}`);
      return;
    }
  } else {
    console.log(`✅ Найден существующий текстовый канал: ${textChannel.name}`);
  }

  // 3. Голосовой канал для создания комнат
  console.log(`🔍 Поиск голосового канала "${CONFIG.VOICE_CREATE_NAME}" в категории...`);
  let voiceCreate = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === CONFIG.VOICE_CREATE_NAME && c.parentId === category.id
  );
  if (!voiceCreate) {
    console.log(`⚠️ Голосовой канал не найден, создаём...`);
    try {
      voiceCreate = await guild.channels.create({
        name: CONFIG.VOICE_CREATE_NAME,
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
      console.log(`✅ Голосовой канал создан: ${voiceCreate.name}`);
    } catch (error) {
      console.error(`❌ Ошибка при создании голосового канала: ${error.message}`);
      return;
    }
  } else {
    console.log(`✅ Найден существующий голосовой канал: ${voiceCreate.name}`);
  }

  // 4. Отправляем панель управления в текстовый канал
  await sendControlPanelMessage(textChannel);
}

/**
 * Отправляет (или обновляет) сообщение с кнопкой открытия панели управления.
 */
async function sendControlPanelMessage(channel) {
  // Удаляем старые сообщения бота (чтобы не захламлять)
  const messages = await channel.messages.fetch({ limit: 10 });
  const botMessages = messages.filter((msg) => msg.author.id === client.user.id);
  for (const msg of botMessages.values()) {
    await msg.delete().catch(console.error);
  }

  const embed = new EmbedBuilder()
    .setTitle('🎮 Управление приватными комнатами')
    .setDescription('Нажмите кнопку ниже, чтобы открыть панель управления вашей комнатой.')
    .setColor(0x00ff00);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_control_panel')
      .setLabel('Управление комнатой')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎮')
  );

  await channel.send({ embeds: [embed], components: [row] });
  console.log(`📨 Панель управления отправлена в канал ${channel.name}`);
}

// Обработка входа/выхода из голосовых каналов
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const category = findCategory(guild);
  if (!category) return;

  // Вход в канал "создать [+]"
  const createChannel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === CONFIG.VOICE_CREATE_NAME && c.parentId === category.id
  );
  if (newState.channelId === createChannel?.id) {
    const member = newState.member;
    // Проверяем, нет ли уже у пользователя комнаты
    const existingRoom = Array.from(activeRooms.values()).find((room) => room.ownerId === member.id);
    if (existingRoom) {
      // Если есть, перемещаем его туда
      await member.voice.setChannel(existingRoom.channel).catch(console.error);
      return;
    }

    // Создаём новую комнату
    const roomName = `Комната ${member.user.username}`;
    try {
      const newChannel = await guild.channels.create({
        name: roomName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          {
            id: guild.id, // @everyone
            deny: [PermissionsBitField.Flags.Connect], // По умолчанию комната закрыта для всех, кроме владельца
          },
          {
            id: member.id,
            allow: [
              PermissionsBitField.Flags.Connect,
              PermissionsBitField.Flags.Speak,
              PermissionsBitField.Flags.ViewChannel,
            ],
          },
        ],
      });

      // Сохраняем в хранилище
      activeRooms.set(newChannel.id, { ownerId: member.id, channel: newChannel });

      // Перемещаем пользователя
      await member.voice.setChannel(newChannel).catch(console.error);

      console.log(`✅ Создана комната ${newChannel.name} для ${member.user.tag}`);
    } catch (error) {
      console.error(`❌ Ошибка при создании комнаты: ${error.message}`);
    }
  }

  // Выход из комнаты (проверяем только каналы, которые есть в activeRooms)
  if (oldState.channelId && activeRooms.has(oldState.channelId)) {
    const channel = oldState.channel;
    if (channel.members.size === 0) {
      // Удаляем канал и запись
      try {
        await channel.delete();
        activeRooms.delete(channel.id);
        console.log(`🗑️ Комната ${channel.name} удалена (пуста).`);
      } catch (error) {
        console.error(`❌ Ошибка при удалении комнаты: ${error.message}`);
      }
    }
  }
});

/**
 * Вспомогательная функция для получения категории (по ID или имени)
 */
function findCategory(guild) {
  if (CONFIG.CATEGORY_ID) {
    return guild.channels.cache.get(CONFIG.CATEGORY_ID);
  } else {
    return guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === CONFIG.CATEGORY_NAME
    );
  }
}

// Обработка взаимодействий (кнопки, модалки)
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    await handleButton(interaction);
  } else if (interaction.type === InteractionType.ModalSubmit) {
    await handleModal(interaction);
  }
});

async function handleButton(interaction) {
  const { customId, user } = interaction;

  // Кнопка открытия панели управления (из текстового канала)
  if (customId === 'open_control_panel') {
    const room = Array.from(activeRooms.values()).find((r) => r.ownerId === user.id);
    if (!room) {
      return interaction.reply({
        content: '❌ У вас нет активной комнаты. Зайдите в канал `создать [+]`, чтобы создать новую.',
        ephemeral: true,
      });
    }

    const panel = buildControlPanel(room.channel, room.ownerId);
    await interaction.reply({ ...panel, ephemeral: true });
    return;
  }

  // Все остальные кнопки требуют наличия комнаты и прав владельца
  const room = Array.from(activeRooms.values()).find((r) => r.ownerId === user.id);
  if (!room) {
    return interaction.reply({
      content: '❌ Ваша комната больше не существует или вы не являетесь её владельцем.',
      ephemeral: true,
    });
  }

  const channel = room.channel;

  // Обновление панели
  if (customId === 'refresh_panel') {
    const panel = buildControlPanel(channel, room.ownerId);
    await interaction.update(panel);
    return;
  }

  // Увеличение лимита пользователей
  if (customId === 'inc_limit') {
    let newLimit = (channel.userLimit || 0) + 1;
    if (newLimit > 99) newLimit = 99;
    await channel.edit({ userLimit: newLimit });
    const panel = buildControlPanel(channel, room.ownerId);
    await interaction.update(panel);
    return;
  }

  // Уменьшение лимита
  if (customId === 'dec_limit') {
    let newLimit = (channel.userLimit || 0) - 1;
    if (newLimit < 0) newLimit = 0;
    await channel.edit({ userLimit: newLimit });
    const panel = buildControlPanel(channel, room.ownerId);
    await interaction.update(panel);
    return;
  }

  // Переключение приватности (закрыть/открыть)
  if (customId === 'toggle_privacy') {
    const everyoneRole = interaction.guild.roles.everyone;
    const currentOverwrites = channel.permissionOverwrites.cache.get(everyoneRole.id);
    const isClosed = currentOverwrites?.deny.has(PermissionsBitField.Flags.Connect) ?? false;

    if (isClosed) {
      // Открываем: убираем запрет на Connect
      await channel.permissionOverwrites.edit(everyoneRole, { Connect: null });
    } else {
      // Закрываем: запрещаем Connect
      await channel.permissionOverwrites.edit(everyoneRole, { Connect: false });
    }

    const panel = buildControlPanel(channel, room.ownerId);
    await interaction.update(panel);
    return;
  }

  // Передача владельца (вызов модалки)
  if (customId === 'transfer_owner') {
    const modal = new ModalBuilder()
      .setCustomId('transfer_owner_modal')
      .setTitle('Передача владельца');

    const userIdInput = new TextInputBuilder()
      .setCustomId('new_owner_id')
      .setLabel('ID нового владельца')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Введите ID пользователя')
      .setRequired(true);

    const actionRow = new ActionRowBuilder().addComponents(userIdInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
    return;
  }

  // Изменение названия (вызов модалки)
  if (customId === 'change_name') {
    const modal = new ModalBuilder()
      .setCustomId('change_name_modal')
      .setTitle('Изменение названия комнаты');

    const nameInput = new TextInputBuilder()
      .setCustomId('new_name')
      .setLabel('Новое название')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Введите новое название')
      .setRequired(true)
      .setMaxLength(100);

    const actionRow = new ActionRowBuilder().addComponents(nameInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
    return;
  }
}

async function handleModal(interaction) {
  const { customId, user } = interaction;

  const room = Array.from(activeRooms.values()).find((r) => r.ownerId === user.id);
  if (!room) {
    return interaction.reply({
      content: '❌ Ваша комната больше не существует или вы не являетесь её владельцем.',
      ephemeral: true,
    });
  }

  const channel = room.channel;

  // Обработка модалки передачи владельца
  if (customId === 'transfer_owner_modal') {
    const newOwnerId = interaction.fields.getTextInputValue('new_owner_id');
    const newOwner = await interaction.guild.members.fetch(newOwnerId).catch(() => null);
    if (!newOwner) {
      return interaction.reply({
        content: '❌ Пользователь с таким ID не найден на сервере.',
        ephemeral: true,
      });
    }

    if (newOwner.id === user.id) {
      return interaction.reply({
        content: '❌ Вы уже являетесь владельцем этой комнаты.',
        ephemeral: true,
      });
    }

    // Обновляем права: убираем у старого владельца, даём новому
    await channel.permissionOverwrites.delete(user.id);
    await channel.permissionOverwrites.create(newOwner.id, {
      Connect: true,
      Speak: true,
      ViewChannel: true,
    });

    // Обновляем запись в хранилище
    activeRooms.set(channel.id, { ownerId: newOwner.id, channel });

    await interaction.reply({
      content: `✅ Владелец комнаты передан пользователю ${newOwner.user.tag}.`,
      ephemeral: true,
    });
    return;
  }

  // Обработка модалки изменения названия
  if (customId === 'change_name_modal') {
    const newName = interaction.fields.getTextInputValue('new_name');
    await channel.edit({ name: newName });

    // Обновляем панель
    const panel = buildControlPanel(channel, room.ownerId);
    await interaction.update(panel);
    return;
  }
}

/**
 * Строит панель управления (embed + кнопки) для конкретной комнаты.
 */
function buildControlPanel(channel, ownerId) {
  const isClosed = channel.permissionOverwrites.cache
    .get(channel.guild.roles.everyone.id)
    ?.deny.has(PermissionsBitField.Flags.Connect) ?? false;

  const embed = new EmbedBuilder()
    .setTitle(`🎛️ Управление: ${channel.name}`)
    .setColor(isClosed ? 0xff0000 : 0x00ff00)
    .addFields(
      { name: 'Название', value: channel.name, inline: true },
      { name: 'Лимит пользователей', value: channel.userLimit === 0 ? 'Безлимит' : channel.userLimit.toString(), inline: true },
      { name: 'Приватность', value: isClosed ? '🔒 Закрыта' : '🔓 Открыта', inline: true },
      { name: 'Владелец', value: `<@${ownerId}>`, inline: true }
    )
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('inc_limit')
      .setLabel('➕ Лимит +')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('dec_limit')
      .setLabel('➖ Лимит -')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('toggle_privacy')
      .setLabel(isClosed ? '🔓 Открыть' : '🔒 Закрыть')
      .setStyle(isClosed ? ButtonStyle.Success : ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('transfer_owner')
      .setLabel('👑 Передать')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('change_name')
      .setLabel('✏️ Изменить название')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('refresh_panel')
      .setLabel('🔄 Обновить')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

// Запуск бота
client.login(CONFIG.TOKEN);