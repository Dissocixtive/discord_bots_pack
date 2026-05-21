const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events, EmbedBuilder, ChannelType } = require('discord.js');
const fs = require('fs').promises;
const config = require('./config.json');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

const COUNTER_FILE = './counter.json';
const tickets = new Map(); // threadId -> { creatorId, assigneeId, status, number, logEntries }

async function getNextTicketNumber() {
    try {
        const data = await fs.readFile(COUNTER_FILE, 'utf8');
        const counter = JSON.parse(data);
        const nextNumber = (counter.lastTicketNumber || 0) + 1;
        counter.lastTicketNumber = nextNumber;
        await fs.writeFile(COUNTER_FILE, JSON.stringify(counter, null, 2));
        return nextNumber;
    } catch (error) {
        if (error.code === 'ENOENT') {
            const initial = { lastTicketNumber: 1 };
            await fs.writeFile(COUNTER_FILE, JSON.stringify(initial, null, 2));
            return 1;
        }
        throw error;
    }
}

async function sendFinalLog(ticket) {
    if (!config.logChannelId) return;
    try {
        const logChannel = await client.channels.fetch(config.logChannelId);
        if (!logChannel) return;

        const logText = ticket.logEntries.join('\n');
        const finalLog = logText.length > 1900 ? logText.substring(0, 1900) + '\n... (лог обрезан)' : logText;

        await logChannel.send({
            content: `**Итоговый лог тикета #${ticket.number}**\n\`\`\`\n${finalLog}\n\`\`\``
        });
    } catch (error) {
        console.error('Ошибка отправки финального лога:', error);
    }
}

client.once(Events.ClientReady, async () => {
    console.log(`Бот ${client.user.tag} готов!`);

    const commands = [{ name: 'ticket', description: 'Создать новый тикет' }];
    const rest = new REST({ version: '10' }).setToken(config.token);

    try {
        console.log('Регистрация слеш-команд...');
        await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
        console.log('Команды зарегистрированы.');
    } catch (error) {
        console.error('Ошибка при регистрации команд:', error);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ticket') {
        const modal = new ModalBuilder()
            .setCustomId('ticketModal')
            .setTitle('Создание тикета');

        const descriptionInput = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Опишите вашу проблему')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(descriptionInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === 'ticketModal') {
        const description = interaction.fields.getTextInputValue('description');
        const ticketNumber = await getNextTicketNumber();
        const threadName = `ticket #${ticketNumber.toString().padStart(3, '0')}`;

        const forumChannel = await client.channels.fetch(config.forumChannelId);
        if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
            return interaction.reply({ content: 'Ошибка: канал форума не найден или имеет неверный тип.', flags: 64 });
        }

        try {
            const thread = await forumChannel.threads.create({
                name: threadName,
                message: {
                    content: `**Описание:**\n${description}\n\n**Создатель:** ${interaction.user.tag} (${interaction.user.id})`
                },
                reason: `Тикет #${ticketNumber} от ${interaction.user.tag}`
            });

            await thread.members.add(interaction.user.id);

            const logEntries = [];
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
            logEntries.push(`[${timestamp}] Тикет создан пользователем ${interaction.user.tag} (${interaction.user.id})`);
            logEntries.push(`[${timestamp}] Описание: ${description}`);

            tickets.set(thread.id, {
                creatorId: interaction.user.id,
                assigneeId: null,
                status: 'open',
                number: ticketNumber,
                threadId: thread.id,
                logEntries: logEntries
            });

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`accept_${thread.id}`)
                        .setLabel('Принять')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`close_${thread.id}`)
                        .setLabel('Закрыть')
                        .setStyle(ButtonStyle.Danger)
                );

            await thread.send({
                content: 'Управление тикетом:',
                components: [row]
            });

            await interaction.reply({ content: `Тикет создан: ${thread.url}`, flags: 64 });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: 'Произошла ошибка при создании тикета.', flags: 64 });
        }
    }
});

client.on(Events.MessageCreate, async message => {
    if (!message.channel.isThread()) return;
    const ticket = tickets.get(message.channel.id);
    if (!ticket) return;
    if (message.author.id === client.user.id) return;
    if (message.type !== 0) return;

    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const logLine = `[${timestamp}] ${message.author.tag}: ${message.content}`;
    ticket.logEntries.push(logLine);
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;

    const [action, threadId] = interaction.customId.split('_');

    const ticket = tickets.get(threadId);
    if (!ticket && action !== 'feedback') {
        return interaction.reply({ content: 'Тикет не найден или уже закрыт.', flags: 64 });
    }

    if (action !== 'feedback') {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(config.supportRoleId)) {
            return interaction.reply({ content: 'У вас нет прав для этого действия.', flags: 64 });
        }
    }

    if (action === 'accept') {
        if (ticket.assigneeId) {
            return interaction.reply({ content: `Тикет уже принят пользователем <@${ticket.assigneeId}>.`, flags: 64 });
        }

        ticket.assigneeId = interaction.user.id;
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        ticket.logEntries.push(`[${timestamp}] Тикет принят сотрудником ${interaction.user.tag} (${interaction.user.id})`);

        const message = interaction.message;
        const disabledRow = ActionRowBuilder.from(message.components[0]).setComponents(
            ButtonBuilder.from(message.components[0].components[0]).setDisabled(true),
            ButtonBuilder.from(message.components[0].components[1])
        );

        await message.edit({
            content: `Тикет принят: <@${interaction.user.id}>`,
            components: [disabledRow]
        });

        await interaction.channel.send({
            content: `✅ Тикет принят сотрудником <@${interaction.user.id}>. Скоро с вами свяжутся.`
        });

        await interaction.reply({ content: 'Вы приняли тикет.', flags: 64 });
    }
    else if (action === 'close') {
        if (ticket.status !== 'open') {
            return interaction.reply({ content: 'Тикет уже закрыт.', flags: 64 });
        }

        ticket.status = 'closed';
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        ticket.logEntries.push(`[${timestamp}] Тикет закрыт сотрудником ${interaction.user.tag} (${interaction.user.id})`);

        try {
            await interaction.message.edit({ components: [] });
        } catch (e) {
            console.error('Не удалось отредактировать сообщение:', e);
        }

        await sendFinalLog(ticket);

        const creator = await client.users.fetch(ticket.creatorId).catch(() => null);
        if (creator) {
            const feedbackRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`feedback_${threadId}`)
                        .setLabel('Оставить отзыв')
                        .setStyle(ButtonStyle.Primary)
                );

            await creator.send({
                content: `Ваш тикет #${ticket.number} был закрыт. Пожалуйста, оставьте отзыв о работе поддержки.`,
                components: [feedbackRow]
            }).catch(() => {
                console.log(`Не удалось отправить ЛС пользователю ${creator.tag}`);
            });
        }

        await interaction.reply({ content: 'Тикет закрыт и будет удалён.', flags: 64 });

        try {
            const thread = await interaction.channel.fetch();
            await thread.delete();
        } catch (e) {
            console.error('Не удалось удалить тред:', e);
        }

        // Не удаляем данные тикета, чтобы номер был доступен для отзыва
        // tickets.delete(threadId);
    }
    else if (action === 'feedback') {
        const modal = new ModalBuilder()
            .setCustomId(`feedbackModal_${threadId}`)
            .setTitle('Оставить отзыв');

        const feedbackInput = new TextInputBuilder()
            .setCustomId('feedbackText')
            .setLabel('Ваш отзыв')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(feedbackInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId.startsWith('feedbackModal_')) {
        const threadId = interaction.customId.split('_')[1];
        const feedbackText = interaction.fields.getTextInputValue('feedbackText');

        const ticket = tickets.get(threadId) || { creatorId: interaction.user.id, number: '?' };

        const feedbackChannel = await client.channels.fetch(config.feedbackChannelId).catch(() => null);
        if (feedbackChannel) {
            const embed = new EmbedBuilder()
                .setTitle('Новый отзыв')
                .setDescription(feedbackText)
                .addFields(
                    { name: 'От пользователя', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Тикет', value: `#${ticket.number}`, inline: true }
                )
                .setColor(0x00FF00)
                .setTimestamp();

            await feedbackChannel.send({ embeds: [embed] });
        }

        await interaction.reply({ content: 'Спасибо за ваш отзыв!', flags: 64 });
    }
});

client.login(config.token);