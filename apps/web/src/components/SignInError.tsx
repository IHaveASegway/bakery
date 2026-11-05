import { useEffect, useState } from 'react';
import { oauthErrorSentence } from '../lib/messages';
import Message from './Message';

/** The API sends a failed OAuth sign-in back to /signin/?error=<slug>, with no detail in the URL. */
export default function SignInError() {
  const [sentence, setSentence] = useState<string | null>(null);

  useEffect(() => {
    setSentence(oauthErrorSentence(new URLSearchParams(window.location.search).get('error')));
  }, []);

  return (
    <Message>
      {sentence !== null && (
        <p className="problem">
          <strong>Sign-in did not finish.</strong> {sentence}
        </p>
      )}
    </Message>
  );
}
