import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config.ts';
import { App } from './app/app.ts';

void bootstrapApplication(App, appConfig);
