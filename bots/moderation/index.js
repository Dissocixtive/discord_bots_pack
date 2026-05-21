const { Client, GatewayIntentBits, Collection, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.json');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ] 
});

client.commands = new Collection();
client.muteTimeouts = new Map();
client.pendingReports = new Map();
client.pendingFeedback = new Map();

// Загрузка команд
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        console.log(`✅ Команда "${command.data.name}" загружена.`);
    } else {
        console.log(`⚠️ [ВНИМАНИЕ] Команда в файле ${file} не имеет обязательных полей "data" или "execute".`);
    }
}

// Функция проверки прав по ролям (обновлена для новых действий)
function hasPermission(member, actionType) {
    if (!config.permissions) return false;

    const memberRoles = member.roles.cache;
    const adminRoles = config.permissions.adminRoles || [];
    const moderatorRoles = config.permissions.moderatorRoles || [];
    const supportRoles = config.permissions.supportRoles || [];

    // Администраторы имеют доступ ко всему
    if (adminRoles.some(roleId => memberRoles.has(roleId))) return true;

    // Действия верификации (кроме смены гендера)
    if (['verify', 'male', 'female', 'deny'].includes(actionType)) {
        return supportRoles.some(roleId => memberRoles.has(roleId)) ||
               moderatorRoles.some(roleId => memberRoles.has(roleId));
    }

    // Смена гендера (только support и admin)
    if (actionType === 'changegender') {
        return supportRoles.some(roleId => memberRoles.has(roleId));
    }

    // Действия наказаний (включая снятие мута и предупреждений)
    if (['ban', 'mute', 'warn', 'mute30', 'mute1h', 'mute3h', 'unmute', 'unwarn'].includes(actionType)) {
        return moderatorRoles.some(roleId => memberRoles.has(roleId));
    }

    // Снятие бана (только админы, проверка выше уже вернула true для админов)
    if (actionType === 'unban') {
        return false; // для не-админов всегда false
    }

    return false;
}

// Функция отправки логов
async function sendLog(guild, action, moderator, target, details = '') {
    if (!config.logChannelId) return;
    const logChannel = guild.channels.cache.get(config.logChannelId);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
        .setColor(getColor(action))
        .setTitle(`📋 Модерация: ${action}`)
        .addFields(
            { name: '🛡️ Модератор', value: `<@${moderator.id}> (${moderator.id})`, inline: true },
            { name: '👤 Цель', value: `<@${target.id}> (${target.id})`, inline: true },
            { name: '📝 Детали', value: details || '—', inline: false }
        )
        .setTimestamp();

    await logChannel.send({ embeds: [embed] }).catch(console.error);
}

function getColor(action) {
    const colors = {
        'Бан': 0xFF0000,
        'Снятие бана': 0x00FF00,
        'Мут': 0xFFA500,
        'Снятие мута': 0x00FF00,
        'Предупреждение': 0xFFFF00,
        'Снятие предупреждения': 0x00FF00,
        'Верификация': 0x00AAFF,
        'Смена гендера': 0xAA00FF,
        'Жалоба принята': 0x0099FF,
        'По умолчанию': 0x808080
    };
    return colors[action] || colors['По умолчанию'];
}

// Функция запроса отзыва
async function requestFeedback(user, moderator, targetId, type, guild) {
    console.log(`📨 Запрос отзыва у ${user.tag} (${user.id}) по поводу ${type}`);
    try {
        await user.send('👋 Оставьте, пожалуйста, ваш отзыв о работе модератора одним сообщением. Ваше мнение поможет нам стать лучше!');
        client.pendingFeedback.set(user.id, {
            moderatorId: moderator.id,
            targetId: targetId,
            type: type,
            guildId: guild.id
        });
        console.log(`✅ Запрос отзыва отправлен пользователю ${user.tag}`);
        setTimeout(() => {
            if (client.pendingFeedback.has(user.id)) {
                client.pendingFeedback.delete(user.id);
                console.log(`⏰ Запрос отзыва для ${user.tag} удалён по таймауту`);
            }
        }, 24 * 60 * 60 * 1000);
    } catch (error) {
        console.log(`❌ Не удалось отправить ЛС пользователю ${user.tag}: ${error.message}`);
    }
}

client.once('ready', () => {
    console.log(`✅ Бот ${client.user.tag} готов!`);
    if (config.feedbackChannelId) {
        const channel = client.channels.cache.get(config.feedbackChannelId);
        if (channel) console.log(`📢 Канал для отзывов найден: ${channel.name}`);
        else console.warn(`⚠️ Канал для отзывов с ID ${config.feedbackChannelId} не найден!`);
    } else {
        console.warn('⚠️ feedbackChannelId не указан в config.json');
    }
});

client.on('interactionCreate', async interaction => {
    try {
        // Слеш-команды
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) return;
            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(error);
                const replyContent = 'Произошла ошибка при выполнении команды.';
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: replyContent, ephemeral: true });
                } else {
                    await interaction.reply({ content: replyContent, ephemeral: true });
                }
            }
            return;
        }

        // Модальные окна (report)
        if (interaction.isModalSubmit()) {
            const customId = interaction.customId;
            if (customId.startsWith('report_')) {
                const targetUserId = customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reason');

                const targetUser = await client.users.fetch(targetUserId).catch(() => null);
                if (!targetUser) {
                    return interaction.reply({ content: '❌ Не удалось найти пользователя.', ephemeral: true });
                }

                const reportChannel = interaction.guild.channels.cache.get(config.reportChannelId);
                if (!reportChannel) {
                    return interaction.reply({ content: '❌ Канал для репортов не настроен или не найден.', ephemeral: true });
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚨 Новая жалоба')
                    .addFields(
                        { name: '👤 Отправитель', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                        { name: '👤 Нарушитель', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                        { name: '📝 Причина', value: reason, inline: false },
                        { name: '⏳ Статус', value: 'Ожидает модератора', inline: true }
                    )
                    .setTimestamp();

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('accept_report_placeholder')
                            .setLabel('✅ Принять')
                            .setStyle(ButtonStyle.Success)
                    );

                const reportMessage = await reportChannel.send({ embeds: [embed], components: [row] });
                const updatedRow = ActionRowBuilder.from(row)
                    .setComponents(
                        ButtonBuilder.from(row.components[0])
                            .setCustomId(`accept_report_${reportMessage.id}`)
                    );
                await reportMessage.edit({ components: [updatedRow] });

                client.pendingReports.set(reportMessage.id, {
                    targetUserId,
                    reporterId: interaction.user.id,
                    channelId: reportChannel.id,
                    messageId: reportMessage.id
                });

                await interaction.reply({ content: '✅ Ваша жалоба отправлена в канал модерации.', ephemeral: true });
            }
            return;
        }

        // Кнопки
        if (!interaction.isButton()) return;

        const { customId, guild, message, member: executor, user } = interaction;
        const parts = customId.split('_');
        let action, targetUserId, authorId;

        if (parts.length === 3) {
            [action, targetUserId, authorId] = parts;
        } else if (parts.length === 2) {
            [action, targetUserId] = parts;
            authorId = null;
        } else {
            return interaction.reply({ content: '❌ Неверный формат кнопки.', ephemeral: true });
        }

        // Кнопка принятия жалобы
        if (action === 'accept' && parts[1] === 'report') {
            await interaction.deferReply({ ephemeral: true });

            const reportMessageId = parts[2];
            if (!reportMessageId) {
                return interaction.editReply({ content: '❌ Неверный формат кнопки.' });
            }

            const reportData = client.pendingReports.get(reportMessageId);
            if (!reportData) {
                return interaction.editReply({ content: '❌ Эта жалоба уже обработана или не найдена.' });
            }

            if (!executor.permissions.has('ManageMessages')) {
                return interaction.editReply({ content: '❌ У вас нет прав для принятия жалоб (ManageMessages).' });
            }

            const reportChannel = guild.channels.cache.get(reportData.channelId);
            if (!reportChannel) {
                return interaction.editReply({ content: '❌ Канал жалобы не найден.' });
            }

            let reportMessage;
            try {
                reportMessage = await reportChannel.messages.fetch(reportMessageId);
            } catch {
                return interaction.editReply({ content: '❌ Сообщение с жалобой не найдено.' });
            }

            const oldEmbed = reportMessage.embeds[0];
            const newEmbed = EmbedBuilder.from(oldEmbed)
                .setColor(0x00FF00)
                .spliceFields(-1, 1,
                    { name: '✅ Принято', value: `${executor.user.tag} (${executor.user.id})`, inline: true },
                    { name: '⏳ Статус', value: 'В обработке', inline: true }
                );

            await reportMessage.edit({ embeds: [newEmbed], components: [] });
            client.pendingReports.delete(reportMessageId);

            const targetUser = await client.users.fetch(reportData.targetUserId).catch(() => null);
            if (targetUser) {
                await sendLog(guild, 'Жалоба принята', executor.user, targetUser, `Жалоба на <@${reportData.targetUserId}>`);
            } else {
                await sendLog(guild, 'Жалоба принята', executor.user, executor.user, `Жалоба на <@${reportData.targetUserId}> (цель не найдена)`);
            }

            const reporter = await client.users.fetch(reportData.reporterId).catch(() => null);
            if (reporter) {
                await requestFeedback(reporter, executor.user, reportData.targetUserId, 'report', guild);
            }

            await interaction.editReply({ content: '✅ Вы приняли жалобу.' });
            return;
        }

        // Далее идут кнопки команды /action
        let targetMember;
        try {
            targetMember = await guild.members.fetch(targetUserId);
        } catch {
            return interaction.reply({ content: '❌ Не удалось найти указанного пользователя на сервере.', ephemeral: true });
        }

        // Проверка прав по ролям (кроме cancel)
        if (action !== 'cancel' && !hasPermission(executor, action)) {
            return interaction.reply({ content: '❌ У вас нет прав для выполнения этого действия.', ephemeral: true });
        }

        switch (action) {
            case 'verify':
                {
                    const genderRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId(`male_${targetUserId}_${authorId}`).setLabel('Мальчик').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`female_${targetUserId}_${authorId}`).setLabel('Девочка').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`deny_${targetUserId}_${authorId}`).setLabel('Недопуск').setStyle(ButtonStyle.Danger),
                            new ButtonBuilder().setCustomId(`cancel_${targetUserId}_${authorId}`).setLabel('Отмена').setStyle(ButtonStyle.Secondary)
                        );
                    await interaction.update({ components: [genderRow] });
                }
                break;

            case 'male':
            case 'female':
                {
                    const roleId = config.roles[action];
                    if (!roleId) return interaction.reply({ content: `❌ Роль ${action} не настроена.`, ephemeral: true });
                    try {
                        const genderRoles = [config.roles.male, config.roles.female].filter(id => id);
                        await targetMember.roles.remove(genderRoles);
                        await targetMember.roles.add(roleId);
                        await sendLog(guild, 'Верификация', executor.user, targetMember.user, `Выдана роль: ${action}`);
                        
                        await requestFeedback(targetMember.user, executor.user, targetUserId, 'verification', guild);

                        await interaction.update({ 
                            content: `✅ Пользователь ${targetMember.user.tag} успешно верифицирован.`, 
                            components: [], 
                            embeds: message.embeds 
                        });
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: '❌ Не удалось выдать/снять роль.', ephemeral: true });
                    }
                }
                break;

            case 'deny':
                {
                    if (!config.roles.deny) return interaction.reply({ content: '❌ Роль deny не настроена.', ephemeral: true });
                    try {
                        await targetMember.roles.add(config.roles.deny);
                        await sendLog(guild, 'Верификация (отказ)', executor.user, targetMember.user, 'Выдана роль deny');
                        
                        await requestFeedback(targetMember.user, executor.user, targetUserId, 'verification', guild);

                        await interaction.update({ 
                            content: `❌ Пользователь ${targetMember.user.tag} не допущен.`, 
                            components: [], 
                            embeds: message.embeds 
                        });
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: '❌ Не удалось выдать роль deny.', ephemeral: true });
                    }
                }
                break;

            case 'changegender':
                {
                    const changeGenderRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId(`male_${targetUserId}_${authorId}`).setLabel('Мальчик').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`female_${targetUserId}_${authorId}`).setLabel('Девочка').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`cancel_${targetUserId}_${authorId}`).setLabel('Отмена').setStyle(ButtonStyle.Secondary)
                        );
                    await interaction.update({ components: [changeGenderRow] });
                }
                break;

            case 'ban':
                {
                    if (!config.roles.ban) return interaction.reply({ content: '❌ Роль бана не настроена.', ephemeral: true });
                    try {
                        await targetMember.roles.add(config.roles.ban);
                        await sendLog(guild, 'Бан', executor.user, targetMember.user, 'Выдан бан');
                        await interaction.update({ content: `бан выдан пользователю ${targetMember.user.tag}.`, components: [], embeds: message.embeds });
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'Не удалось выдать бан.', ephemeral: true });
                    }
                }
                break;

            case 'unban':
                {
                    if (!config.roles.ban) return interaction.reply({ content: 'бан не настроен.', ephemeral: true });
                    if (!targetMember.roles.cache.has(config.roles.ban)) {
                        return interaction.reply({ content: 'У пользователя нет бана.', ephemeral: true });
                    }
                    try {
                        await targetMember.roles.remove(config.roles.ban);
                        await sendLog(guild, 'Снятие бана', executor.user, targetMember.user, 'Роль бана удалена');
                        await interaction.update({ content: `Бан снят с пользователя ${targetMember.user.tag}.`, components: [], embeds: message.embeds });
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'Не удалось снять бан.', ephemeral: true });
                    }
                }
                break;

            case 'mute':
                {
                    const durationRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId(`mute30_${targetUserId}_${authorId}`).setLabel('30 мин').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`mute1h_${targetUserId}_${authorId}`).setLabel('1 час').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`mute3h_${targetUserId}_${authorId}`).setLabel('3 часа').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`cancel_${targetUserId}_${authorId}`).setLabel('Отмена').setStyle(ButtonStyle.Danger)
                        );
                    await interaction.update({ components: [durationRow] });
                }
                break;

            case 'mute30':
            case 'mute1h':
            case 'mute3h':
                {
                    if (!config.roles.mute) return interaction.reply({ content: 'мут не настроен.', ephemeral: true });
                    let durationMs, durationText;
                    if (action === 'mute30') { durationMs = 30 * 60 * 1000; durationText = '30 минут'; }
                    else if (action === 'mute1h') { durationMs = 60 * 60 * 1000; durationText = '1 час'; }
                    else { durationMs = 3 * 60 * 60 * 1000; durationText = '3 часа'; }

                    try {
                        await targetMember.roles.add(config.roles.mute);
                        await sendLog(guild, 'Мут', executor.user, targetMember.user, `Длительность: ${durationText}`);
                        await interaction.update({ content: `Пользователь ${targetMember.user.tag} получил мут на ${durationText}.`, components: [], embeds: message.embeds });

                        if (client.muteTimeouts.has(targetUserId)) {
                            clearTimeout(client.muteTimeouts.get(targetUserId));
                        }

                        const timeout = setTimeout(async () => {
                            try {
                                const member = await guild.members.fetch(targetUserId);
                                await member.roles.remove(config.roles.mute);
                                await sendLog(guild, 'Снятие мута', client.user, member.user, 'Автоматически');
                            } catch (error) {
                                console.error(error);
                            } finally {
                                client.muteTimeouts.delete(targetUserId);
                            }
                        }, durationMs);
                        client.muteTimeouts.set(targetUserId, timeout);
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'Не удалось выдать мут.', ephemeral: true });
                    }
                }
                break;

            case 'unmute':
                {
                    if (!config.roles.mute) return interaction.reply({ content: 'мут не настроен.', ephemeral: true });
                    if (!targetMember.roles.cache.has(config.roles.mute)) {
                        return interaction.reply({ content: 'У пользователя нет мута.', ephemeral: true });
                    }
                    try {
                        await targetMember.roles.remove(config.roles.mute);
                        await sendLog(guild, 'Снятие мута', executor.user, targetMember.user, 'Роль мута удалена');

                        if (client.muteTimeouts.has(targetUserId)) {
                            clearTimeout(client.muteTimeouts.get(targetUserId));
                            client.muteTimeouts.delete(targetUserId);
                        }

                        await interaction.update({ content: `Мут снят с пользователя ${targetMember.user.tag}.`, components: [], embeds: message.embeds });
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'Не удалось снять мут.', ephemeral: true });
                    }
                }
                break;

            case 'warn':
                {
                    const warnRoles = [config.roles.warn1, config.roles.warn2, config.roles.warn3].filter(id => id);
                    if (warnRoles.length !== 3) {
                        return interaction.reply({ content: 'предупреждения настроены не полностью.', ephemeral: true });
                    }

                    let currentWarnLevel = 0;
                    if (targetMember.roles.cache.has(config.roles.warn3)) currentWarnLevel = 3;
                    else if (targetMember.roles.cache.has(config.roles.warn2)) currentWarnLevel = 2;
                    else if (targetMember.roles.cache.has(config.roles.warn1)) currentWarnLevel = 1;

                    try {
                        if (currentWarnLevel === 0) {
                            await targetMember.roles.add(config.roles.warn1);
                            await sendLog(guild, 'Предупреждение', executor.user, targetMember.user, 'Уровень 1/3');
                            await interaction.update({ content: `Пользователю ${targetMember.user.tag} выдано предупреждение 1/3.`, components: [], embeds: message.embeds });
                        } else if (currentWarnLevel === 1) {
                            await targetMember.roles.remove(config.roles.warn1);
                            await targetMember.roles.add(config.roles.warn2);
                            await sendLog(guild, 'Предупреждение', executor.user, targetMember.user, 'Уровень 2/3');
                            await interaction.update({ content: `Пользователю ${targetMember.user.tag} выдано предупреждение 2/3.`, components: [], embeds: message.embeds });
                        } else if (currentWarnLevel === 2) {
                            await targetMember.roles.remove(config.roles.warn2);
                            await targetMember.roles.add(config.roles.warn3);
                            await sendLog(guild, 'Предупреждение', executor.user, targetMember.user, 'Уровень 3/3');
                            await interaction.update({ content: `Пользователю ${targetMember.user.tag} выдано предупреждение 3/3.`, components: [], embeds: message.embeds });
                        } else if (currentWarnLevel === 3) {
                            if (!config.roles.mute) return interaction.reply({ content: 'мут не настроен.', ephemeral: true });
                            await targetMember.roles.add(config.roles.mute);
                            await sendLog(guild, 'Автоматический мут', executor.user, targetMember.user, 'Превышен лимит предупреждений (3/3) → мут 1ч');
                            await interaction.update({ content: `Пользователь ${targetMember.user.tag} получил мут на 1 час (превышен лимит предупреждений).`, components: [], embeds: message.embeds });

                            if (client.muteTimeouts.has(targetUserId)) {
                                clearTimeout(client.muteTimeouts.get(targetUserId));
                            }

                            const timeout = setTimeout(async () => {
                                try {
                                    const member = await guild.members.fetch(targetUserId);
                                    await member.roles.remove(config.roles.mute);
                                    await sendLog(guild, 'Снятие мута', client.user, member.user, 'Автоматически');
                                } catch (error) {
                                    console.error(error);
                                } finally {
                                    client.muteTimeouts.delete(targetUserId);
                                }
                            }, 60 * 60 * 1000);
                            client.muteTimeouts.set(targetUserId, timeout);
                        }
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'Не удалось выполнить действие.', ephemeral: true });
                    }
                }
                break;

            case 'unwarn':
                {
                    const warnRoles = [config.roles.warn1, config.roles.warn2, config.roles.warn3].filter(id => id);
                    if (warnRoles.length !== 3) {
                        return interaction.reply({ content: 'предупреждения настроены не полностью.', ephemeral: true });
                    }

                    let currentWarnLevel = 0;
                    if (targetMember.roles.cache.has(config.roles.warn3)) currentWarnLevel = 3;
                    else if (targetMember.roles.cache.has(config.roles.warn2)) currentWarnLevel = 2;
                    else if (targetMember.roles.cache.has(config.roles.warn1)) currentWarnLevel = 1;

                    if (currentWarnLevel === 0) {
                        return interaction.reply({ content: 'У пользователя нет предупреждений.', ephemeral: true });
                    }

                    try {
                        if (currentWarnLevel === 1) {
                            await targetMember.roles.remove(config.roles.warn1);
                            await sendLog(guild, 'Снятие предупреждения', executor.user, targetMember.user, 'Снято предупреждение 1/3');
                            await interaction.update({ content: `Снято предупреждение 1/3 с пользователя ${targetMember.user.tag}.`, components: [], embeds: message.embeds });
                        } else if (currentWarnLevel === 2) {
                            await targetMember.roles.remove(config.roles.warn2);
                            await targetMember.roles.add(config.roles.warn1);
                            await sendLog(guild, 'Снятие предупреждения', executor.user, targetMember.user, 'Снято предупреждение 2/3 → теперь 1/3');
                            await interaction.update({ content: `Снято предупреждение 2/3 с пользователя ${targetMember.user.tag}. Текущий уровень: 1/3.`, components: [], embeds: message.embeds });
                        } else if (currentWarnLevel === 3) {
                            await targetMember.roles.remove(config.roles.warn3);
                            await targetMember.roles.add(config.roles.warn2);
                            await sendLog(guild, 'Снятие предупреждения', executor.user, targetMember.user, 'Снято предупреждение 3/3 → теперь 2/3');
                            await interaction.update({ content: `Снято предупреждение 3/3 с пользователя ${targetMember.user.tag}. Текущий уровень: 2/3.`, components: [], embeds: message.embeds });
                        }
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'Не удалось снять предупреждение.', ephemeral: true });
                    }
                }
                break;

            case 'cancel':
                await interaction.update({ components: [], embeds: message.embeds });
                break;

            default:
                await interaction.reply({ content: 'Неизвестное действие.', ephemeral: true });
        }
    } catch (error) {
        console.error('Необработанная ошибка в interactionCreate:', error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Произошла внутренняя ошибка. Попробуйте позже.', ephemeral: true });
            } else {
                await interaction.followUp({ content: 'Произошла внутренняя ошибка.', ephemeral: true });
            }
        } catch (e) {
            console.error('Не удалось отправить сообщение об ошибке:', e);
        }
    }
});

// Обработчик сообщений (отзывы в ЛС)
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.guild) return;

    const userId = message.author.id;
    const feedbackData = client.pendingFeedback.get(userId);
    if (!feedbackData) return;

    console.log(`📥 Получен отзыв от ${message.author.tag}: "${message.content}"`);

    const feedbackChannel = client.channels.cache.get(config.feedbackChannelId);
    if (!feedbackChannel) {
        console.error(`❌ Канал для отзывов с ID ${config.feedbackChannelId} не найден!`);
        await message.reply('❌ Ошибка: канал для отзывов не настроен. Администратору нужно проверить конфигурацию.');
        client.pendingFeedback.delete(userId);
        return;
    }

    const moderator = await client.users.fetch(feedbackData.moderatorId).catch(() => null);
    const target = await client.users.fetch(feedbackData.targetId).catch(() => null);

    if (!moderator || !target) {
        console.error('❌ Не удалось получить данные модератора или цели для отзыва');
        await message.reply('❌ Ошибка обработки отзыва. Попробуйте позже.');
        client.pendingFeedback.delete(userId);
        return;
    }

    const typeText = feedbackData.type === 'verification' ? 'верификации' : 'репорта';

    const embed = new EmbedBuilder()
        .setColor(0x00AAFF)
        .setTitle(`📝 Отзыв после ${typeText}`)
        .addFields(
            { name: '🛡️ Модератор', value: `<@${moderator.id}> (${moderator.id})`, inline: true },
            { name: '👤 Пользователь', value: `<@${target.id}> (${target.id})`, inline: true },
            { name: '💬 Текст отзыва', value: message.content, inline: false }
        )
        .setTimestamp();

    try {
        await feedbackChannel.send({ embeds: [embed] });
        await message.reply('✅ Спасибо за ваш отзыв!');
        console.log(`✅ Отзыв от ${message.author.tag} успешно отправлен в канал.`);
    } catch (error) {
        console.error('❌ Ошибка при отправке отзыва в канал:', error);
        await message.reply('❌ Не удалось отправить отзыв. Попробуйте позже.');
    } finally {
        client.pendingFeedback.delete(userId);
    }
});

process.on('SIGINT', () => {
    for (const timeout of client.muteTimeouts.values()) clearTimeout(timeout);
    client.destroy();
    console.log('🛑 Бот остановлен.');
    process.exit();
});

client.login(config.token);