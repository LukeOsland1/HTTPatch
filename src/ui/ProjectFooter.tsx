import brand from '@/brand.json';

export function ProjectFooter({ compact = false }: { compact?: boolean }) {
  return (
    <footer class={`project-footer${compact ? ' compact' : ''}`}>
      <a
        class="support-link"
        href={brand.donationUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="Optional donation to support HTTPatch"
      >
        Support on Ko-fi ↗
      </a>
      {!compact && (
        <>
          <span class="muted">Free to use. Donations are optional.</span>
          <a href={chrome.runtime.getURL('privacy.html')} target="_blank" rel="noopener noreferrer">
            Privacy & credits
          </a>
        </>
      )}
    </footer>
  );
}
