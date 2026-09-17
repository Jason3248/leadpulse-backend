'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      role: { type: DataTypes.ENUM('campaign_manager', 'executive', 'client'), allowNull: false },
      managerId: { type: DataTypes.UUID, allowNull: true },
      clientId: { type: DataTypes.UUID, allowNull: true },
      firstName: { type: DataTypes.STRING(50), allowNull: false },
      lastName: { type: DataTypes.STRING(50), allowNull: false },
      email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      passwordHash: { type: DataTypes.STRING(255), allowNull: false },
      // Bumped on password reset, self password change, and Executive/Client
      // deactivation or admin-triggered reset — makes revocation of an
      // already-issued access token real, not just "no new logins allowed".
      tokenVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      refreshTokenHash: { type: DataTypes.STRING(255), allowNull: true },
      refreshTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
      resetTokenHash: { type: DataTypes.STRING(255), allowNull: true },
      resetTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
      failedLoginAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lockedUntil: { type: DataTypes.DATE, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      lastLoginAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
      tableName: 'users',
      underscored: true,
      timestamps: true,
      // Secrets never leave the model by accident — any plain `User.findAll()`
      // or `User.findByPk()` already excludes these. Call `.unscoped()`
      // explicitly in the auth service where the hash is actually needed.
      defaultScope: {
        attributes: { exclude: ['passwordHash', 'refreshTokenHash', 'resetTokenHash'] }
      }
    }
  );

  User.associate = (models) => {
    User.belongsTo(models.User, { as: 'manager', foreignKey: 'managerId' });
    User.hasMany(models.User, { as: 'managedUsers', foreignKey: 'managerId' });
    User.belongsTo(models.Client, { as: 'clientProfile', foreignKey: 'clientId' });
    User.hasMany(models.Client, { as: 'ownedClients', foreignKey: 'managerId' });
  };

  return User;
};
