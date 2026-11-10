import { createApp } from "vue";
import "./styles.css";

import("./App.vue")
  .then(({ default: App }) => createApp(App).mount("#app"))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const diagnostic = document.createElement("pre");
    diagnostic.textContent = message;
    document.body.replaceChildren(diagnostic);
  });
