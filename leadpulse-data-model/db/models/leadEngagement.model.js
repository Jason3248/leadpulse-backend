'use strict';

module.exports = (sequelize, DataTypes) => {
  const LeadEngagement = sequelize.define(
    'LeadEngagement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // The frozen audience row this engagement belongs to. Campaign and
      // lead are both reachable through it, so they're not duplicated here.
      campaignLeadId: { type: DataTypes.UUID, allowNull: false },
      trackingToken: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      status: {
        type: DataTypes.ENUM('sent', 'delivered', 'bounced', 'spamreport'),
        allowNull: false,
        defaultValue: 'sent'
      },
      sentAt: { type: DataTypes.DATE, allowNull: true },
      deliveredAt: { type: DataTypes.DATE, allowNull: true },
      openedAt: { type: DataTypes.DATE, allowNull: true },
      clickedAt: { type: DataTypes.DATE, allowNull: true },
      convertedAt: { type: DataTypes.DATE, allowNull: true },
      unsubscribedAt: { type: DataTypes.DATE, allowNull: true },
      openCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      clickCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // On 'hard': the lead's client_leads.is_hard_bounced is set true
      // (permanent email suppression for that client relationship).
      bounceType: { type: DataTypes.ENUM('hard', 'soft'), allowNull: true },
      errorMessage: { type: DataTypes.TEXT, allowNull: true }
    },
    {
      tableName: 'lead_engagements',
      underscored: true,
      timestamps: true,
      updatedAt: false
    }
  );

  LeadEngagement.associate = (models) => {
    LeadEngagement.belongsTo(models.CampaignLead, { as: 'campaignLead', foreignKey: 'campaignLeadId' });
  };

  return LeadEngagement;
};
