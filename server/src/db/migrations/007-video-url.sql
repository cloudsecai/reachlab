-- Add video_url column for storing direct video URLs for transcription
ALTER TABLE posts ADD COLUMN video_url TEXT;
