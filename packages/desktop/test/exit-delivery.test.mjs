import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createExitDelivery, DEFAULT_EXIT_RETRY_DELAYS_MS } from "../src/exit-delivery.ts";

/**
 * Regressão da falha intermitente da tray (10/10/2026): o pedido do modal era
 * enviado uma única vez e sem reconhecimento; um pedido perdido deixava o
 * clique em "Sair" sem efeito até ao timeout de 30 s (e o utilizador tentava
 * de novo). A entrega tem de:
 *   - REENVIAR até o renderer ACKAR que o modal está apresentado;
 *   - desistir depressa ("gave-up") quando ninguém confirma — nunca 30 s;
 *   - desistir já ("unavailable") quando a janela está morta/crashada;
 *   - nunca deixar a promessa pendente em nenhum caminho.
 */

function fakeClock() {
  let now = 0;
  const jobs = [];
  return {
    schedule(fn, ms) {
      const job = { at: now + ms, fn, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 1000; guard += 1) {
        const next = jobs
          .filter((job) => !job.cancelled && job.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.cancelled = true;
        // O callback vê o tempo LÓGICO do job: um agendamento dentro dele conta
        // a partir daí, não do instante em que o advance começou.
        now = Math.max(now, next.at);
        next.fn();
      }
      now = target;
    },
    get now() {
      return now;
    },
  };
}

describe("exit-delivery — modal apresentado com ack", () => {
  it("reenvia nos prazos definidos até o renderer ACKAR", async () => {
    const clock = fakeClock();
    const sends = [];
    const delivery = createExitDelivery({
      send: () => sends.push(clock.now),
      schedule: clock.schedule,
    });

    const pending = delivery.request();
    assert.deepEqual(sends, [0], "primeiro envio é imediato");

    clock.advance(1200);
    assert.deepEqual(sends, [0, 1200], "reenvio aos 1,2 s");

    clock.advance(1800);
    assert.deepEqual(sends, [0, 1200, 3000], "reenvio aos 3 s");

    delivery.ack();
    assert.equal(await pending, "acked");
    assert.equal(delivery.isAcked, true);
  });

  it("depois do ack não há mais reenvios (ack idempotente)", async () => {
    const clock = fakeClock();
    let sends = 0;
    const delivery = createExitDelivery({
      send: () => {
        sends += 1;
      },
      schedule: clock.schedule,
    });

    const pending = delivery.request();
    clock.advance(1200);
    delivery.ack();
    delivery.ack();
    clock.advance(10_000);

    assert.equal(await pending, "acked");
    assert.equal(sends, 2, "o ack pára os reenvios");
  });

  it("sem ack ⇒ 'gave-up' em ~3,8 s (orçamento curto, nunca 30 s)", async () => {
    const clock = fakeClock();
    let sends = 0;
    const delivery = createExitDelivery({
      send: () => {
        sends += 1;
      },
      schedule: clock.schedule,
    });

    const pending = delivery.request();
    clock.advance(2000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, "aos 2 s ainda está dentro do orçamento");

    clock.advance(1800);
    assert.equal(await pending, "gave-up");
    assert.equal(sends, DEFAULT_EXIT_RETRY_DELAYS_MS.length, "todos os envios foram feitos");
  });

  it("renderer indisponível desiste já, sem gastar reenvios", async () => {
    let sends = 0;
    const delivery = createExitDelivery({
      send: () => {
        sends += 1;
      },
      isRendererAvailable: () => false,
    });

    assert.equal(await delivery.request(), "unavailable");
    assert.equal(sends, 0, "não vale a pena enviar para uma janela morta");
  });

  it("excepção no envio é registada e não deixa promessa pendente", async () => {
    const clock = fakeClock();
    const events = [];
    const delivery = createExitDelivery({
      send: () => {
        throw new Error("pipe morto");
      },
      schedule: clock.schedule,
      onEvent: (event) => events.push(event),
    });

    const pending = delivery.request();
    clock.advance(4000);

    assert.equal(await pending, "gave-up");
    assert.equal(events.filter((e) => e === "exit-delivery:send-error").length, 3);
  });

  it("pedidos concorrentes partilham a mesma entrega (um só fluxo de envios)", async () => {
    const clock = fakeClock();
    let sends = 0;
    const delivery = createExitDelivery({
      send: () => {
        sends += 1;
      },
      schedule: clock.schedule,
    });

    const first = delivery.request();
    const second = delivery.request();
    assert.equal(sends, 1);

    delivery.ack();
    assert.equal(await first, "acked");
    assert.equal(await second, "acked");
  });

  it("um novo pedido depois de desistir volta a enviar e pode ser acked", async () => {
    const clock = fakeClock();
    let sends = 0;
    const delivery = createExitDelivery({
      send: () => {
        sends += 1;
      },
      schedule: clock.schedule,
    });

    const first = delivery.request();
    clock.advance(4000);
    assert.equal(await first, "gave-up");

    const second = delivery.request();
    assert.equal(sends, 4, "novo pedido = novo primeiro envio");
    delivery.ack();
    assert.equal(await second, "acked");
  });
});
