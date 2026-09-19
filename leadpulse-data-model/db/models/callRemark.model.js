'use strict';

module.exports = (sequelize, DataTypes) => {
  const CallRemark = sequelize.define(
    'CallRemark',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // The frozen audience row this remark belongs to. Campaign and lead
      // are both reachable through it, so they're not duplicated here.
      campaignLeadId: { type: DataTypes.UUID, allowNull: false },
      executiveUserId: { type: DataTypes.UUID, allowNull: false },
      callOutcome: {
        type: DataTypes.ENUM(
          'Answered',
          'Not Answered',
          'Busy',
          'Wrong Number',
          'Left Voicemail',
          'Callback Requested',
          'Not Interested',
          'Converted'
        ),
        allowNull: false
      },
      callDurationMinutes: { type: DataTypes.INTEGER, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      followUpDate: { type: DataTypes.DATE, allowNull: true },
      leadStatusUpdate: {
        type: DataTypes.ENUM('New', 'Contacted', 'Qualified', 'Converted', 'Dead'),
        allowNull: true
      },
      isManualEntryByManager: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Billing trust gate, tri-state:
      //   null  = not yet reviewed
      //   true  = confirmed, counts toward cost_per_lead billing
      //   false = reviewed and rejected, reason recorded, not billable
      // DB-enforced so the reviewer is never the reporting executive.
      conversionConfirmed: { type: DataTypes.BOOLEAN, allowNull: true },
      conversionRejectionReason: { type: DataTypes.TEXT, allowNull: true },
      confirmedByUserId: { type: DataTypes.UUID, allowNull: true },
      confirmedAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
      tableName: 'call_remarks',
      underscored: true,
      timestamps: true,
      updatedAt: false
    }
  );

  CallRemark.associate = (models) => {
    CallRemark.belongsTo(models.CampaignLead, { as: 'campaignLead', foreignKey: 'campaignLeadId' });
    CallRemark.belongsTo(models.User, { as: 'executive', foreignKey: 'executiveUserId' });
    CallRemark.belongsTo(models.User, { as: 'confirmedBy', foreignKey: 'confirmedByUserId' });
  };

  return CallRemark;
};
