const Joi = require('joi');

const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(d => d.message)
      });
    }
    
    next();
  };
};

// Pakistan phone number format: 03XX-XXXXXXX
const phoneRegex = /^((\+92)|(0092)|(0))(3)([0-9]{9})$/;
// Pakistan CNIC format: XXXXX-XXXXXXX-X
const cnicRegex = /^[0-9]{5}-[0-9]{7}-[0-9]$/;

const schemas = {
  register: Joi.object({
    phoneNumber: Joi.string().pattern(phoneRegex).required(),
    cnic: Joi.string().pattern(cnicRegex).required(),
    password: Joi.string().min(6).required(),
    firstName: Joi.string().min(2).max(100).required(),
    lastName: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().optional()
  }),
  
  login: Joi.object({
    phoneNumber: Joi.string().pattern(phoneRegex).required(),
    password: Joi.string().required()
  }),
  
  transfer: Joi.object({
    receiverPhone: Joi.string().pattern(phoneRegex).required(),
    amount: Joi.number().positive().min(10).max(100000).required(),
    description: Joi.string().max(255).optional()
  })
};

module.exports = { validateRequest, schemas };
