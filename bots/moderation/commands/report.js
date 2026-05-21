const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('report')
        .setDescription('Пожаловаться на пользователя')
        .addUserOption(option =>
            option.setName('пользователь')
                .setDescription('Пользователь, на которого вы хотите пожаловаться')
                .setRequired(true)),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('пользователь');

        // Создаём модальное окно
        const modal = new ModalBuilder()
            .setCustomId(`report_${targetUser.id}`)
            .setTitle(`Жалоба на ${targetUser.tag}`);

        // Поле для ввода причины
        const reasonInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Причина жалобы')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Опишите причину жалобы...')
            .setRequired(true)
            .setMaxLength(1000);

        const actionRow = new ActionRowBuilder().addComponents(reasonInput);
        modal.addComponents(actionRow);

        // Показываем модальное окно пользователю
        await interaction.showModal(modal);
    },
};