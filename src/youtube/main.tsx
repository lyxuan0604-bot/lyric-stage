import './polyfill';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../i18n/config';
import '../index.css';
import './youtube.css';
import YouTubeStageApp from './YouTubeStageApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <YouTubeStageApp />
  </React.StrictMode>,
);
