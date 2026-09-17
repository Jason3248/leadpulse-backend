'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      role: { type: Sequelize.ENUM('campaign_manager', 'executive', 'client'), allowNull: false },
      // Self-referencing: Executives/Clients belong to the Manager who created
      // them. Null for a self-registered Campaign Manager.
      manager_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      },
      // FK to `clients` added in migration 003, once that table exists —
      // avoids a create-time circular dependency between users <-> clients.
      client_id: { type: Sequelize.UUID, allowNull: true },
      first_name: { type: Sequelize.STRING(50), allowNull: false },
      last_name: { type: Sequelize.STRING(50), allowNull: false },
      email: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      password_hash: { type: Sequelize.STRING(255), allowNull: false },
      token_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      refresh_token_hash: { type: Sequelize.STRING(255), allowNull: true },
      refresh_token_expires_at: { type: Sequelize.DATE, allowNull: true },
      reset_token_hash: { type: Sequelize.STRING(255), allowNull: true },
      reset_token_expires_at: { type: Sequelize.DATE, allowNull: true },
      failed_login_attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      locked_until: { type: Sequelize.DATE, allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_login_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('users', ['manager_id'], { name: 'users_manager_id_idx' });
    await queryInterface.addIndex('users', ['role'], { name: 'users_role_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('users');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_role";');
  }
};
