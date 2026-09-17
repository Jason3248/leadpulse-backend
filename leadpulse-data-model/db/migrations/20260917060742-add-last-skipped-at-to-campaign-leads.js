'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize)
  {
    // Lets an Executive pass on a lead ("not now") without fabricating a
    // call_remarks row — logging "Not Answered" for a call that was never
    // actually dialed pollutes calls-logged stats and call history with a
    // phantom attempt. This column feeds the SAME queue-ordering signal
    // real attempts already use (see call.service.js's lastWorkedAt), so a
    // skipped lead drops to the back exactly like a worked one would,
    // without ever touching call_remarks.
    await queryInterface.addColumn('campaign_leads', 'last_skipped_at', {
      type: Sequelize.DATE,
      allowNull: true
    });
  },

  async down(queryInterface)
  {
    await queryInterface.removeColumn('campaign_leads', 'last_skipped_at');
  }
};