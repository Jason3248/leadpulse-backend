'use strict';

module.exports = (sequelize, DataTypes) => {
  const ImportJob = sequelize.define(
    'ImportJob',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      clientId: { type: DataTypes.UUID, allowNull: false },
      leadListId: { type: DataTypes.UUID, allowNull: true },
      leadListName: { type: DataTypes.STRING(255), allowNull: true },
      startedByUserId: { type: DataTypes.UUID, allowNull: false },
      originalFilename: { type: DataTypes.STRING(255), allowNull: false },
      sourceFileKey: { type: DataTypes.STRING(500), allowNull: true },
      errorFileKey: { type: DataTypes.STRING(500), allowNull: true },
      status: {
        type: DataTypes.ENUM('uploaded', 'queued', 'processing', 'completed', 'completed_with_errors', 'failed'),
        allowNull: false,
        defaultValue: 'uploaded'
      },
      totalRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      processedRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      successfulRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failedRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      newToAgency: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      matchedFromAgencyDatabase: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      alreadyMappedToClient: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failureReason: { type: DataTypes.TEXT, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      finishedAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
      tableName: 'import_jobs',
      underscored: true,
      timestamps: true
    }
  );

  // Derived rather than stored — there's no way for it to drift out of sync
  // with the counters it's computed from.
  ImportJob.prototype.progressPercentage = function progressPercentage() {
    if (this.totalRows === 0) return this.isTerminal() ? 100 : 0;
    return Math.round((this.processedRows / this.totalRows) * 100);
  };

  ImportJob.prototype.isTerminal = function isTerminal() {
    return ['completed', 'completed_with_errors', 'failed'].includes(this.status);
  };

  ImportJob.associate = (models) => {
    ImportJob.belongsTo(models.Client, { as: 'client', foreignKey: 'clientId' });
    ImportJob.belongsTo(models.LeadList, { as: 'leadList', foreignKey: 'leadListId' });
    ImportJob.belongsTo(models.User, { as: 'startedBy', foreignKey: 'startedByUserId' });
  };

  return ImportJob;
};
