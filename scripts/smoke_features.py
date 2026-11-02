import asyncio
import sys

sys.path.insert(0, "/opt/exclaw/app")

from dotenv import load_dotenv

load_dotenv("/home/exclaw/.jiuwenclaw/config/.env")

from jiuwenclaw.pi_agent import project_flow, feature_llm


for name, mod in [("project_flow", project_flow)]:
    cfg = mod._llm_config()
    print(
        f"{name}: provider={cfg['provider']!r} base={cfg['api_base']!r} "
        f"model={cfg['model']!r} key_set={bool(cfg['api_key'])}"
    )


async def main() -> None:
    msg = [{"role": "user", "content": "Reply with the single word: pong"}]
    cfg = feature_llm.resolve_config()
    out = await feature_llm.call_llm(msg, cfg, temperature=0.0, max_tokens=20)
    print("LIVE:", out.strip())


asyncio.run(main())
