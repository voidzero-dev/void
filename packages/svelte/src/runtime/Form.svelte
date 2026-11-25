<script lang="ts">
  import type { Snippet } from 'svelte';
  import { formErrorMessage, formRetryMessage, formSubmissionBlocked, scheduleFormRetry } from 'void/pages-client';
import type { FormModel, FormMethod, VoidActionError } from 'void/pages-client';
  let { form, method='post', renderError, children, ...rest }: {
    form: FormModel;
    method?: FormMethod;
    renderError?: Snippet<[VoidActionError]>;
    children?: Snippet;
    [key: string]: unknown;
  } = $props();
  let now=$state(Date.now());
  const message=$derived(formErrorMessage(form));
  const retry=$derived(formRetryMessage(form.error));
  $effect(()=>scheduleFormRetry(form.error,()=>{now=Date.now();}));
</script>

<form {...rest} aria-busy={form.pending} onsubmit={async event=>{
  event.preventDefault();
  if (!formSubmissionBlocked(form,now)) await form[method]();
}}>
  {#if message}
    <div role="alert" data-void-form-error>
      {#if form.error && renderError}{@render renderError(form.error)}{:else}{message}{/if}
      {#if retry}<p>{retry}</p>{/if}
    </div>
  {/if}
  {@render children?.()}
</form>
