'use strict';

const { z } = require('zod');

// SRS 4.1.1: min 8 chars, one uppercase, one digit, one special character.
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one digit')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

const recaptchaField = z.string().optional();

const register = z
  .object({
    firstName: z.string().trim().min(1, 'First name is required').max(50),
    lastName: z.string().trim().min(1, 'Last name is required').max(50),
    email: z.string().trim().toLowerCase().email('Invalid email address'),
    password: passwordSchema,
    confirmPassword: z.string(),
    recaptchaToken: recaptchaField
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  });

const login = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  recaptchaToken: recaptchaField
});

const forgotPassword = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address')
});

const resetPassword = z
  .object({
    token: z.string().min(1, 'Reset token is required'),
    password: passwordSchema,
    confirmPassword: z.string(),
    recaptchaToken: recaptchaField
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  });

// The self-service counterpart to resetPassword — proof of identity here
// is knowing the CURRENT password rather than owning the email inbox.
// Available to every role; nothing here is Manager/Executive/Client-specific.
const changePassword = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
    confirmNewPassword: z.string()
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Passwords do not match',
    path: ['confirmNewPassword']
  });

// SRS 4.11 Profile: display name update. Both fields optional individually
// (update just one if you like), but at least one must be present.
const updateProfile = z
  .object({
    firstName: z.string().trim().min(1, 'First name cannot be empty').max(50).optional(),
    lastName: z.string().trim().min(1, 'Last name cannot be empty').max(50).optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No fields to update.' });

module.exports = { register, login, forgotPassword, resetPassword, changePassword, updateProfile };
