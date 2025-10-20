import { Component, inject, signal } from '@angular/core';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { FormsModule } from '@angular/forms';
import { injectMutation } from '@tanstack/angular-query-experimental';
import { RoastCardComponent } from './roast-card/roast-card.component';

@Component({
  imports: [FormsModule, RoastCardComponent],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  functions = inject(Functions);
  isRoastCardOpen = signal(false);

  workflowHealthMutation = injectMutation(() => ({
    mutationFn: async (repoInput: string) => {
      const [owner, repo] = repoInput.split('/').map(s => s.trim());
      
      if (!owner || !repo) {
        throw new Error('Please enter a valid repository in format: owner/repo');
      }
      
      const callable = httpsCallable<{ owner: string; repo: string }, string>(
        this.functions,
        'workflowHealthFunction',
      );
      const result = await callable({ owner, repo });
      console.log('Workflow health result:', result);
      return result.data;
    },
    onSuccess: (data: string) => {
      console.log('Analysis successful:', data);
      this.isRoastCardOpen.set(true);
    },
    onError: (error: unknown) => {
      console.error('Analysis failed:', error);
      alert('Failed to analyze workflows. Please check the repository name and try again.');
    },
  }));

  closeRoastCard(): void {
    this.isRoastCardOpen.set(false);
  }
}
