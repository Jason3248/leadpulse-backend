'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // A sequence pointing at one lead list while its child campaigns point
    // at another created two contradictory audience definitions with nothing
    // preventing the mismatch. The campaign owns the audience; the sequence
    // is purely a grouping label, so this column is removed.
    await queryInterface.removeColumn('sequences', 'lead_list_id');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('sequences', 'lead_list_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'lead_lists', key: 'id' }
    });
  }
};
