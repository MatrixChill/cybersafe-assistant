import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MonitorPage from '../src/pages/MonitorPage';
it('o Monitor não apresenta comentários de implementação como texto', () => {
 const html = renderToStaticMarkup(createElement(MonitorPage, {events: [], processes: [], connections: [], protection: null, quarantine: []}));
 assert.doesNotMatch(html, /Categoria tool:|metadados reais|\/\*|\*\//);
});

