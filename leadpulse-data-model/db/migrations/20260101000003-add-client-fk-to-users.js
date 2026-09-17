'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addConstraint('users', {
      fields: ['client_id'],
      type: 'foreign key',
      name: 'fk_users_client_id',
      references: { table: 'clients', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addIndex('users', ['client_id'], { name: 'users_client_id_idx' });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('users', 'fk_users_client_id');
  }
};
