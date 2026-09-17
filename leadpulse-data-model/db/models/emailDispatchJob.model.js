'use strict';

module.exports = (sequelize, DataTypes) => {
  const EmailDispatchJob = sequelize.define(
    'EmailDispatchJob',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaignId: { type: DataTypes.UUID, allowNull: false },
      startedByUserId: { type: DataTypes.UUID, allowNull: false },
      status: {
        type: DataTypes.ENUM('queued', 'processing', 'completed', 'completed_with_errors', 'failed'),
        allowNull: false,
        defaultValue: 'queued'
      },
      totalRecipients: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      processed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      sent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // Leads skipped by the live consent re-check at send time (dnc,
      // unsubscribed, hard-bounced, or already converted/dead elsewhere).
      suppressed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failureReason: { type: DataTypes.TEXT, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      finishedAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
      tableName: 'email_dispatch_jobs',
      underscored: true,
      timestamps: true
    }
  );

  EmailDispatchJob.prototype.progressPercentage = function progressPercentage() {
    if (!this.totalRecipients) return 0;
    return Math.round((this.processed / this.totalRecipients) * 100);
  };

  EmailDispatchJob.associate = (models) => {
    EmailDispatchJob.belongsTo(models.Campaign, { as: 'campaign', foreignKey: 'campaignId' });
    EmailDispatchJob.belongsTo(models.User, { as: 'startedBy', foreignKey: 'startedByUserId' });
  };

  return EmailDispatchJob;
};
