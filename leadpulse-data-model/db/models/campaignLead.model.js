'use strict';

module.exports = (sequelize, DataTypes) =>
{
  const CampaignLead = sequelize.define(
    'CampaignLead',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaignId: { type: DataTypes.UUID, allowNull: false },
      leadId: { type: DataTypes.UUID, allowNull: false },
      // Call campaigns only — stays null for email rows.
      assignedExecutiveId: { type: DataTypes.UUID, allowNull: true },
      queueStatus: {
        type: DataTypes.ENUM('pending', 'in_progress', 'called', 'skipped', 'completed'),
        allowNull: true
      },
      // Feeds the SAME ordering signal a genuine call attempt does, without
      // ever writing a call_remarks row — see call.service.js's skipLead().
      lastSkippedAt: { type: DataTypes.DATE, allowNull: true },
      addedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    },
    {
      tableName: 'campaign_leads',
      underscored: true,
      timestamps: false
    }
  );

  CampaignLead.associate = (models) =>
  {
    CampaignLead.belongsTo(models.Campaign, { as: 'campaign', foreignKey: 'campaignId' });
    CampaignLead.belongsTo(models.Lead, { as: 'lead', foreignKey: 'leadId' });
    CampaignLead.belongsTo(models.User, { as: 'assignedExecutive', foreignKey: 'assignedExecutiveId' });
    CampaignLead.hasMany(models.LeadEngagement, { as: 'engagements', foreignKey: 'campaignLeadId' });
    CampaignLead.hasMany(models.CallRemark, { as: 'callRemarks', foreignKey: 'campaignLeadId' });
  };

  return CampaignLead;
};
