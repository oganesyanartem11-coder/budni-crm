import { formatDateNumeric, formatMoney } from '@/lib/utils/format'
import { amountToWords } from '@/lib/upd/amount-to-words'
import type {
  UpdSupplierSnapshot,
  UpdBuyerSnapshot,
  UpdLineSnapshot,
} from '../types'

interface DocData {
  documentNumber: string
  deliveryDate: Date
  totalAmount: string
  vatAmount: string | null
  vatRate: string | null
  amountWithoutVat: string
  supplier: UpdSupplierSnapshot
  buyer: UpdBuyerSnapshot
  lines: UpdLineSnapshot[]
}

export function UpdDocumentRender({
  doc,
  copyLabel,
}: {
  doc: DocData
  copyLabel: string
}) {
  const { supplier, buyer, lines } = doc
  const totalNum = parseFloat(doc.totalAmount)
  const rub = Math.trunc(totalNum)
  const kop = Math.round((totalNum - rub) * 100)

  return (
    <div
      className="print-page bg-surface border border-border rounded-2xl p-6 mb-6 upd-page"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="upd-header">
        <div className="text-center mb-2">
          <div className="text-xs uppercase tracking-wider text-fg-muted">{copyLabel}</div>
          <h1 className="text-xl font-bold mt-1">Универсальный передаточный документ</h1>
          <div className="text-sm text-fg-muted mt-0.5">
            Статус: <strong>1</strong> — счёт-фактура и передаточный документ
          </div>
        </div>

        <div className="border-t border-b border-fg-subtle/30 py-2 mb-3 text-sm text-center">
          <strong>Счёт-фактура № {doc.documentNumber}</strong>{' '}
          от {formatDateNumeric(doc.deliveryDate)}
        </div>
      </div>

      <table className="upd-parties w-full text-xs mb-3">
        <tbody>
          <tr>
            <td className="upd-party-label">Продавец</td>
            <td>
              <div className="font-medium">{supplier.fullName}</div>
              <div className="text-fg-muted">{supplier.legalAddress}</div>
              <div className="text-fg-muted">
                ИНН {supplier.inn}{supplier.kpp ? ` / КПП ${supplier.kpp}` : ''} · ОГРН{supplier.entityType === 'INDIVIDUAL_ENTREPRENEUR' ? 'ИП' : ''} {supplier.ogrn}
              </div>
            </td>
          </tr>
          <tr>
            <td className="upd-party-label">Грузоотправитель</td>
            <td>он же</td>
          </tr>
          <tr>
            <td className="upd-party-label">Грузополучатель</td>
            <td>
              <div className="font-medium">{buyer.legalName ?? buyer.clientName}</div>
              <div className="text-fg-muted">
                {buyer.locationName} · {buyer.locationAddress}
              </div>
            </td>
          </tr>
          <tr>
            <td className="upd-party-label">Покупатель</td>
            <td>
              <div className="font-medium">{buyer.legalName ?? buyer.clientName}</div>
              {buyer.legalAddress && <div className="text-fg-muted">{buyer.legalAddress}</div>}
              {buyer.inn && (
                <div className="text-fg-muted">
                  ИНН {buyer.inn}{buyer.kpp ? ` / КПП ${buyer.kpp}` : ''}
                  {buyer.ogrn ? ` · ОГРН ${buyer.ogrn}` : ''}
                </div>
              )}
            </td>
          </tr>
          {(buyer.contractNumber || buyer.contractDateIso) && (
            <tr>
              <td className="upd-party-label">Основание</td>
              <td>
                Договор {buyer.contractNumber ? `№ ${buyer.contractNumber}` : ''}
                {buyer.contractDateIso ? ` от ${formatDateNumeric(new Date(buyer.contractDateIso))}` : ''}
              </td>
            </tr>
          )}
          <tr>
            <td className="upd-party-label">Банк продавца</td>
            <td className="text-fg-muted">
              {supplier.bankName} · р/с {supplier.bankAccount} · к/с {supplier.bankCorrAccount} · БИК {supplier.bankBic}
            </td>
          </tr>
          {buyer.bankName && (
            <tr>
              <td className="upd-party-label">Банк покупателя</td>
              <td className="text-fg-muted">
                {buyer.bankName}{buyer.bankAccount ? ` · р/с ${buyer.bankAccount}` : ''}
                {buyer.bankCorrAccount ? ` · к/с ${buyer.bankCorrAccount}` : ''}
                {buyer.bankBic ? ` · БИК ${buyer.bankBic}` : ''}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <table className="upd-lines w-full text-xs">
        <thead>
          <tr>
            <th>№</th>
            <th>Наименование</th>
            <th>Кол-во</th>
            <th>Ед.</th>
            <th>Цена</th>
            <th>Без НДС</th>
            <th>Ставка</th>
            <th>Сумма НДС</th>
            <th>С НДС</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, idx) => (
            <tr key={l.orderId}>
              <td className="text-center">{idx + 1}</td>
              <td>
                Реализация готовых обедов ({l.mealLabel}), {formatDateNumeric(new Date(l.deliveryDateIso))}
              </td>
              <td className="text-right tabular-nums">{l.portions}</td>
              <td>порц.</td>
              <td className="text-right tabular-nums">{l.pricePerPortion}</td>
              <td className="text-right tabular-nums">{l.lineTotalWithoutVat}</td>
              <td className="text-center">{doc.vatRate ? `${doc.vatRate}%` : 'Без НДС'}</td>
              <td className="text-right tabular-nums">{l.lineVat ?? '—'}</td>
              <td className="text-right tabular-nums">{l.lineTotal}</td>
            </tr>
          ))}
          <tr className="upd-totals">
            <td colSpan={5} className="text-right font-semibold">Итого:</td>
            <td className="text-right tabular-nums font-semibold">{doc.amountWithoutVat}</td>
            <td></td>
            <td className="text-right tabular-nums font-semibold">{doc.vatAmount ?? '—'}</td>
            <td className="text-right tabular-nums font-semibold">{doc.totalAmount}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-3 text-xs space-y-0.5">
        <div>
          <strong>Всего к оплате:</strong> {formatMoney(doc.totalAmount, { withKopecks: true })}
        </div>
        <div>
          {doc.vatRate
            ? <>в т.ч. НДС {doc.vatRate}%: {formatMoney(doc.vatAmount ?? '0', { withKopecks: true })}</>
            : <>Без НДС</>}
        </div>
        <div className="italic">Сумма прописью: {amountToWords(rub, kop)}</div>
      </div>

      <div className="upd-signatures mt-5 grid grid-cols-2 gap-6 text-xs">
        <div>
          <div className="mb-1 font-medium">Товар (груз) передал:</div>
          <div className="upd-sig-line" />
          <div className="text-fg-muted mt-1">
            {supplier.directorPosition} {supplier.directorName}
          </div>
          <div className="text-fg-muted mt-3">Дата отгрузки: {formatDateNumeric(doc.deliveryDate)}</div>
          <div className="text-fg-muted mt-2">М.П.</div>
        </div>
        <div>
          <div className="mb-1 font-medium">Товар (груз) получил:</div>
          <div className="upd-sig-line" />
          <div className="text-fg-muted mt-1">
            должность / Ф. И. О.
          </div>
          <div className="text-fg-muted mt-3">Дата получения: ___________________</div>
          <div className="text-fg-muted mt-2">М.П.</div>
        </div>
      </div>

      <div className="mt-4 text-[10px] text-fg-subtle text-center">
        {copyLabel}. Сформировано Будни CRM
      </div>
    </div>
  )
}
