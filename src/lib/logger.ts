import winston, { format } from 'winston';
import ecsFormat from '@elastic/ecs-winston-format';

const logger = winston.createLogger({
  format: process.env.NODE_ENV === 'production' ? ecsFormat() : format.combine(format.colorize(), format.simple()),
  transports: [new winston.transports.Console({ level: process.env.DEBUG === '1' ? 'debug' : 'info' })],
});

export default logger;
