/**
 * E3.5: an honest provider is never reported as truncating when a session reads prose in scripts other than Latin
 * and CJK.
 *
 * The provider counts every request with a real tokenizer (E2's simulator), accepts everything up to the declared
 * window and never truncates. The session explores a repository (search output and file listings), then reads two
 * ordinary documents written in Russian or Bulgarian. Every test expects no detection.
 *
 * textTokens prices each letter outside ASCII and CJK at DENSITY.other, so Russian prose costs three to four times its
 * real tokens there, and the floor of such prose was its estimate. Exploration output calibrates the session ratio to
 * about 1.2 to 1.35, and at that ratio a Russian document read as evidence of truncation: test 1 detected in 0.7.0
 * too, and test 2 detected with ADR 0033's pair, an evidence sample and a marginal one. The floor now prices those
 * letters and marks as ASCII letters (textTokensFloor). The last test checks prose in each script (prose-scripts.ts)
 * at a session ratio of 1: none may read below 0.5 of the floor in real tokens.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { textTokensFloor } from "../../../../../.pi/extensions/penpi/engine/estimator.ts";
import { installProviderSim } from "../context-engine-e2/provider-sim.ts";
import { CountingTokenizer, loadTokenizer, TOKENIZERS } from "../context-engine-e2/tokenizers.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { blobExtension, finalTurn, scriptedModel } from "./helpers.ts";
import { PROSE } from "./prose-scripts.ts";

const harnesses: Harness[] = [];
const WINDOW = 200_000;

// The context: what exploring this repository prints. `git ls-files`, a listing of its TypeScript files as `find`
// prints them, and its exported declarations as `rg -n` prints them, taken in turn.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const sources = tracked.split("\n").filter((f) => /^packages\/(coding-agent|ai|agent)\/src\/.*\.ts$/.test(f));
const found = `${tracked
	.split("\n")
	.filter((f) => f.endsWith(".ts"))
	.map((f) => `./${f}`)
	.join("\n")}\n`;
const matches = sources
	.flatMap((f) =>
		readFileSync(`${root}${f}`, "utf8")
			.split("\n")
			.map((line, n) => (/^export (function|const|class|interface|type) /.test(line) ? `${f}:${n + 1}:${line}` : ""))
			.filter(Boolean),
	)
	.join("\n");
function inTurn(...texts: string[]): string {
	const out: string[] = [];
	for (let at = 0; texts.some((t) => at < t.length); at += 8_000)
		for (const t of texts) if (at < t.length) out.push(t.slice(at, at + 8_000));
	return out.join("\n");
}
const explored = inTurn(matches, tracked, found);
if (explored.length < 430_000)
	throw new Error(`honest-scripts: ${explored.length} characters of search output, 430,000 needed`);

// Ordinary prose, written for this test.
const ru = {
	contract:
		"Настоящий договор вступает в силу с момента его подписания обеими сторонами и действует до полного исполнения сторонами своих обязательств. Исполнитель обязуется оказать услуги, предусмотренные приложением к настоящему договору, в соответствии с требованиями действующего законодательства Российской Федерации. Заказчик обязуется своевременно предоставить необходимую информацию и документацию, а также оплатить оказанные услуги в порядке и в сроки, установленные настоящим договором. Ответственность сторон определяется в соответствии с законодательством Российской Федерации. Все споры и разногласия, возникающие в связи с исполнением настоящего договора, разрешаются путём переговоров, а при невозможности достижения соглашения подлежат рассмотрению в арбитражном суде по месту нахождения ответчика.",
	manual:
		"Перед началом эксплуатации оборудования внимательно ознакомьтесь с настоящим руководством. Устройство предназначено для использования в закрытых помещениях при температуре окружающего воздуха от пяти до сорока градусов. Подключение к электрической сети должно выполняться квалифицированным специалистом. Запрещается эксплуатация устройства с повреждённым кабелем питания. Техническое обслуживание следует проводить не реже одного раза в год в авторизованном сервисном центре. Производитель оставляет за собой право вносить изменения в конструкцию изделия без предварительного уведомления.",
	dataProtection:
		"Организации обязаны обеспечивать сохранность персональных данных работников и клиентов в соответствии с требованиями федерального законодательства. Обработка персональных данных допускается только с согласия субъекта персональных данных, за исключением случаев, предусмотренных законом. Оператор обязан принимать необходимые организационные и технические меры для защиты персональных данных от неправомерного доступа, уничтожения, изменения, блокирования, копирования и распространения. Ответственность за нарушение установленных требований определяется действующим законодательством.",
	news: "Правительство утвердило программу развития транспортной инфраструктуры на ближайшие пять лет. Как сообщили в пресс-службе министерства, на реализацию программы будет направлено значительное финансирование из федерального бюджета. В рамках программы планируется строительство новых автомобильных дорог, реконструкция железнодорожных вокзалов и модернизация аэропортов в нескольких регионах страны. По словам министра, реализация проекта позволит существенно сократить время в пути между крупными городами и создать дополнительные рабочие места. Эксперты отмечают, что успешное выполнение программы во многом зависит от своевременного финансирования и эффективного контроля за расходованием средств.",
	abstract:
		"В статье рассматриваются современные подходы к обработке естественного языка с использованием нейронных сетей. Особое внимание уделяется методам предварительного обучения языковых моделей на больших объёмах текстовых данных. Проведённые эксперименты показывают, что предложенный метод позволяет повысить качество классификации текстов по сравнению с существующими решениями. Результаты исследования могут быть использованы при разработке информационно-поисковых систем, систем автоматического реферирования и диалоговых помощников. В заключение обсуждаются ограничения предложенного подхода и направления дальнейших исследований.",
	installation:
		"Для установки приложения необходимо выполнить следующие действия. Сначала скачайте установочный пакет с официального сайта разработчика. Затем запустите программу установки и следуйте инструкциям на экране. После завершения установки перезагрузите компьютер. При первом запуске приложение предложит создать учётную запись пользователя или войти в существующую. Настройки программы хранятся в конфигурационном файле, который находится в домашнем каталоге пользователя. Для изменения параметров откройте раздел настроек в главном меню. Обратите внимание, что некоторые изменения вступают в силу только после перезапуска приложения. Если при работе возникают ошибки, проверьте журнал событий и обратитесь в службу технической поддержки.",
};
const bg = {
	company:
		"Дружеството с ограничена отговорност се управлява от общото събрание на съдружниците и от управителя. Управителят организира и ръководи дейността на дружеството съобразно закона и решенията на общото събрание и представлява дружеството пред трети лица. Съдружниците отговарят за задълженията на дружеството до размера на дяловете си в капитала. Решенията за изменение на дружествения договор, за приемане и изключване на съдружник и за увеличаване или намаляване на капитала се вземат с мнозинство, предвидено в закона. Прехвърлянето на дружествен дял се извършва с договор с нотариална заверка на подписите и се вписва в търговския регистър.",
	contract:
		"Настоящият договор влиза в сила от датата на подписването му от двете страни и е валиден до пълното изпълнение на задълженията по него. Изпълнителят се задължава да предостави услугите, описани в приложението, в съответствие с изискванията на действащото законодателство на Република България. Възложителят се задължава да предостави своевременно необходимата информация и документация и да заплати уговореното възнаграждение в сроковете, определени в договора. Всички спорове, възникнали във връзка с изпълнението на договора, се решават чрез преговори, а при непостигане на съгласие се отнасят за разглеждане от компетентния съд.",
	dataProtection:
		"Администраторът на лични данни е длъжен да осигури защита на личните данни на служителите и клиентите в съответствие с изискванията на закона. Обработването на лични данни се допуска само със съгласието на физическото лице, освен в случаите, предвидени в закона. Администраторът предприема необходимите технически и организационни мерки за защита на данните от неправомерен достъп, унищожаване, изменение или разпространение. Отговорността за нарушаване на установените изисквания се определя съгласно действащото законодателство.",
};
const en =
	"This agreement enters into force when it is signed by both parties and remains in effect until the parties have fully performed their obligations. The contractor undertakes to provide the services set out in the annex to this agreement in accordance with applicable law. The customer undertakes to provide the necessary information and documentation in good time and to pay for the services rendered within the periods set by this agreement. All disputes arising from the performance of this agreement are settled by negotiation, and failing agreement they are referred to the competent court.";
const doc = (title: string, ...paragraphs: string[]) => `# ${title}\n\n${paragraphs.join("\n\n")}\n`;

async function session(tokenizer: "o200k" | "glm", first: string, second: string, options = {}) {
	const stats = newStats();
	const lines: string[] = [];
	const notices: string[] = [];
	const blobs: Record<string, string> = { first, second };
	for (let i = 0; i < 12; i++) blobs[`big${i}`] = explored.slice(i * 32_000, (i + 1) * 32_000);
	for (let i = 0; i < 12; i++) blobs[`small${i}`] = explored.slice(384_000 + i * 3_000, 384_000 + (i + 1) * 3_000);
	const read = (blob: string, say = "Looking at the next part of the repository.") => ({ blob, say });
	const steps = [
		...Array.from({ length: 12 }, (_, i) => read(`big${i}`)),
		...[0, 1, 2].map((i) => read(`small${i}`)),
		read("first", "Reading the first document."),
		...[3, 4].map((i) => read(`small${i}`)),
		read("second", "Reading the second document."),
		...[5, 6, 7, 8, 9, 10].map((i) => read(`small${i}`)),
	];
	const harness = await createHarness({
		models: [{ id: "honest", contextWindow: WINDOW, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			blobExtension(Object.fromEntries(Object.entries(blobs).map(([k, text]) => [k, { text }]))),
			createContextEngine({ stats, ...options, log: (l: string) => lines.push(l) }),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
	// Honest: rejects only above the declared window, never truncates, reports exactly what it counted.
	const sim = installProviderSim(harness, {
		tokenizer,
		counter: new CountingTokenizer(await loadTokenizer(tokenizer)),
		limit: WINDOW,
		mode: "reject",
		errorStyle: "anthropic",
	});
	const model = scriptedModel(harness);
	steps.forEach((step, n) => {
		model.push(() =>
			fauxAssistantMessage([fauxText(step.say), fauxToolCall("blob", { name: step.blob }, { id: `call-${n}` })], {
				stopReason: "toolUse",
			}),
		);
	});
	model.push(finalTurn("All done."));
	await harness.session.prompt("Explore the repository, read the two documents, then report.");
	return { stats, lines, notices, sim };
}

/** The provider truncated and rejected nothing, and the engine reported no truncation and learned no window. */
function expectHonest(r: Awaited<ReturnType<typeof session>>) {
	expect(r.sim.calls.filter((c) => c.truncated || c.rejected)).toHaveLength(0);
	expect(r.stats.plateaus, r.lines.filter((l) => l.includes("silent truncation")).join("\n")).toHaveLength(0);
	expect(r.notices.filter((n) => n.includes("silently truncated"))).toHaveLength(0);
	expect(r.stats.lastLimits?.window).toBe(WINDOW);
}

describe("E3.5: an honest provider, a repository explored, documents in other scripts", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const russianA = doc("Договор оказания услуг", ru.contract, ru.manual, ru.dataProtection);
	const russianB = doc("Новости и исследования", ru.news, ru.abstract, ru.installation);
	const bulgarian = doc("Договор за услуги", bg.contract, bg.dataProtection, bg.company);

	for (const tokenizer of ["o200k", "glm"] as const) {
		it(`${tokenizer}, control: two documents in English`, async () => {
			expectHonest(
				await session(tokenizer, doc("Service agreement", en, en, en), doc("Service agreement, copy", en, en, en)),
			);
		});

		it(`${tokenizer}, 1 (0.7.0's rules too): two documents in Russian`, async () => {
			expectHonest(await session(tokenizer, russianA, russianB));
		});

		it(`${tokenizer}, 2 (new with ADR 0033): a document in Russian, then one in Bulgarian`, async () => {
			// With the pair off (0.7.0's rule), the lone evidence sample waits for a second and nothing is detected.
			expectHonest(await session(tokenizer, russianA, bulgarian, { silentMarginalPair: false }));
			expectHonest(await session(tokenizer, russianA, bulgarian));
		});
	}

	it("prose in each script reads 0.5 or more of the floor in real tokens, with o200k and with GLM", async () => {
		const counters = await Promise.all(TOKENIZERS.map((t) => loadTokenizer(t)));
		const low: string[] = [];
		for (const [name, text] of Object.entries(PROSE)) {
			const floor = textTokensFloor(text);
			for (const [i, counter] of counters.entries()) {
				const ratio = counter.count(text) / floor;
				if (ratio < 0.5) low.push(`${name}, ${TOKENIZERS[i]}: ${ratio.toFixed(3)}`);
			}
		}
		expect(low).toEqual([]);
	});
});
