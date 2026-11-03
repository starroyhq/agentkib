import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/features/conversation/components/ui/button";
import { useEnvironment } from "@/providers/environment";
import {
  finishComputerAccountLogin,
  computerAccountLoginBound,
} from "@/features/connection/account-login";
import { accountLoginCopy } from "@/features/connection/account-login-copy";

export const Route = createFileRoute("/account-callback")({ component: AccountCallback });
function AccountCallback() {
  const { locale } = useEnvironment();
  const copy = accountLoginCopy[locale];
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const back = () => location.replace(location.pathname + location.search + "#/pair");
  useEffect(() => {
    let alive = true;
    void finishComputerAccountLogin()
      .then(() => {
        if (alive) back();
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-8">
      <h1>{copy.title}</h1>
      <p role={failed ? "alert" : "status"}>{failed ? copy.failed : copy.loading}</p>
      {failed && (
        <>
          {readFailed && <p role="alert">{copy.unavailable}</p>}
          <Button
            disabled={checking}
            onClick={() => {
              setChecking(true);
              setReadFailed(false);
              void computerAccountLoginBound()
                .then((bound) => {
                  if (bound) back();
                })
                .catch(() => setReadFailed(true))
                .finally(() => setChecking(false));
            }}
          >
            {copy.check}
          </Button>
          <Button variant="outline" onClick={back}>
            {copy.retry}
          </Button>
        </>
      )}
    </main>
  );
}
