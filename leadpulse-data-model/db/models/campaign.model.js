'use strict';

module.exports = (sequelize, DataTypes) => {
  const Campaign = sequelize.define(
    'Campaign',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      clientId: { type: DataTypes.UUID, allowNull: false },
      leadListId: { type: DataTypes.UUID, allowNull: false },
      sequenceId: { type: DataTypes.UUID, allowNull: true },
      sequenceStepOrder: { type: DataTypes.INTEGER, allowNull: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      type: { type: DataTypes.ENUM('email', 'call'), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      categoryTag: { type: DataTypes.STRING(100), allowNull: true },
      status: {
        type: DataTypes.ENUM('draft', 'active', 'paused', 'completed'),
        allowNull: false,
        defaultValue: 'draft'
      },
      // Guards against a double-send when multiple Executives are assigned —
      // flipped via a single atomic conditional UPDATE, never read-then-write.
      dispatchStatus: {
        type: DataTypes.ENUM('not_sent', 'sending', 'sent'),
        allowNull: false,
        defaultValue: 'not_sent'
      },
      // { industry, jobTitle, source, membershipStatus } — composed into a
      // dynamic Sequelize where-clause by the campaign audience builder.
      segmentationFilters: { type: DataTypes.JSONB, allowNull: true },
      excludeClosedLeads: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      pricingModel: { type: DataTypes.ENUM('flat_retainer', 'cost_per_lead'), allowNull: true },
      retainerAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      ratePerLead: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      budgetAlert90Sent: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'budget_alert_90_sent'
      },
      budgetAlert100Sent: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'budget_alert_100_sent'
      },
      requiresManagerApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      approvedByUserId: { type: DataTypes.UUID, allowNull: true },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      // Email-only fields — stay null for call campaigns.
      subjectLine: { type: DataTypes.STRING(255), allowNull: true },
      senderName: { type: DataTypes.STRING(150), allowNull: true },
      replyToEmail: { type: DataTypes.STRING(255), allowNull: true },
      emailBodyHtml: { type: DataTypes.TEXT, allowNull: true },
      bannerImageUrl: { type: DataTypes.STRING(500), allowNull: true },
      scheduleType: { type: DataTypes.ENUM('send_now', 'scheduled'), allowNull: true },
      scheduledAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
      tableName: 'campaigns',
      underscored: true,
      timestamps: true
    }
  );

  Campaign.associate = (models) => {
    Campaign.belongsTo(models.Client, { as: 'client', foreignKey: 'clientId' });
    Campaign.belongsTo(models.LeadList, { as: 'leadList', foreignKey: 'leadListId' });
    Campaign.belongsTo(models.Sequence, { as: 'sequence', foreignKey: 'sequenceId' });
    Campaign.belongsTo(models.User, { as: 'createdBy', foreignKey: 'createdByUserId' });
    Campaign.belongsTo(models.User, { as: 'approvedBy', foreignKey: 'approvedByUserId' });

    Campaign.hasMany(models.CampaignExecutive, { as: 'executiveAssignments', foreignKey: 'campaignId' });
    Campaign.belongsToMany(models.User, {
      through: models.CampaignExecutive,
      as: 'executives',
      foreignKey: 'campaignId',
      otherKey: 'executiveUserId'
    });

    // Single audience mechanism for BOTH channel types — the frozen snapshot
    // written at approval time. For email, assignedExecutiveId/queueStatus
    // stay null on each row; for call, they carry real queue state.
    Campaign.hasMany(models.CampaignLead, { as: 'campaignLeads', foreignKey: 'campaignId' });
    Campaign.belongsToMany(models.Lead, {
      through: models.CampaignLead,
      as: 'leads',
      foreignKey: 'campaignId',
      otherKey: 'leadId'
    });

  };

  return Campaign;
};
