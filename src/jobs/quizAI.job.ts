import cron from 'node-cron';
import { generateQuestionsIfNeeded } from '../services/quizAI.service';
import { logger } from '../utils/logger';

export function startQuizAIJob(): void {
  cron.schedule('0 3 * * *', async () => {
    logger.info('quizAI.job: running daily AI question generation check...');
    try {
      await generateQuestionsIfNeeded();
      logger.info('quizAI.job: AI question generation complete');
    } catch (err) {
      logger.error('quizAI.job: failed', { err });
    }
  });

  logger.info('quizAI.job: scheduled daily at 03:00 UTC');
}
