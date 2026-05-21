const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('action')
        .setDescription('Показать информацию о пользователе и действия модерации')
        .addUserOption(option =>
            option.setName('пользователь')
                .setDescription('Пользователь (ID, упоминание или имя)')
                .setRequired(true)),
    async execute(interaction) {
        await interaction.deferReply();

        const targetUser = interaction.options.getUser('пользователь');
        if (!targetUser) {
            return interaction.editReply('Пользователь не найден.');
        }

        let member;
        try {
            member = await interaction.guild.members.fetch(targetUser.id);
        } catch {
            return interaction.editReply('Этот пользователь не на сервере или не удалось получить информацию.');
        }

        const avatarURL = targetUser.displayAvatarURL({ size: 1024, dynamic: true });
        const nickname = member.displayName;
        const joinedAt = member.joinedAt;

        const joinedFormatted = joinedAt.toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Moscow'
        });

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`Информация о пользователе ${targetUser.tag}`)
            .setThumbnail(avatarURL)
            .addFields(
                { name: 'Никнейм на сервере', value: nickname, inline: true },
                { name: 'ID пользователя', value: targetUser.id, inline: true },
                { name: 'Дата присоединения к серверу', value: joinedFormatted, inline: false }
            )
            .setTimestamp();

        // Роли исполнителя команды
        const executorRoles = interaction.member.roles.cache;
        const authorId = interaction.user.id;

        // Загружаем настройки прав из конфига
        const supportRoles = config.permissions?.supportRoles || [];
        const moderatorRoles = config.permissions?.moderatorRoles || [];
        const adminRoles = config.permissions?.adminRoles || [];

        const hasAnyRole = (roleIds) => roleIds.some(id => executorRoles.has(id));

        const isAdmin = hasAnyRole(adminRoles);
        const isModerator = isAdmin || hasAnyRole(moderatorRoles);
        const isSupport = isAdmin || hasAnyRole(supportRoles);

        const rows = [];

        // Ряд для support (верификация и смена гендера)
        if (isSupport) {
            const supportRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`verify_${targetUser.id}_${authorId}`)
                    .setLabel('Верификация')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`changegender_${targetUser.id}_${authorId}`)
                    .setLabel('🔄 Сменить гендер')
                    .setStyle(ButtonStyle.Secondary)
            );
            rows.push(supportRow);
        }

        // Ряд для модераторов (наказания)
        if (isModerator) {
            const modRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ban_${targetUser.id}_${authorId}`)
                    .setLabel('Бан')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`mute_${targetUser.id}_${authorId}`)
                    .setLabel('Мут')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`warn_${targetUser.id}_${authorId}`)
                    .setLabel('Предупреждение')
                    .setStyle(ButtonStyle.Primary)
            );
            rows.push(modRow);
        }

        // Ряд для снятия наказаний (unmute и unwarn доступны модераторам, unban только админам)
        const removeRow = new ActionRowBuilder();
        if (isModerator) {
            removeRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`unmute_${targetUser.id}_${authorId}`)
                    .setLabel('🔇 Снять мут')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`unwarn_${targetUser.id}_${authorId}`)
                    .setLabel('⚠️ Снять предупреждение')
                    .setStyle(ButtonStyle.Primary)
            );
        }
        if (isAdmin) {
            removeRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`unban_${targetUser.id}_${authorId}`)
                    .setLabel('⚖️ Снять бан')
                    .setStyle(ButtonStyle.Danger)
            );
        }
        if (removeRow.components.length > 0) {
            rows.push(removeRow);
        }

        if (rows.length === 0) {
            return interaction.editReply({
                embeds: [embed],
                content: '❌ У вас нет прав на использование модерационных кнопок.'
            });
        }

        await interaction.editReply({ embeds: [embed], components: rows });
    },
};