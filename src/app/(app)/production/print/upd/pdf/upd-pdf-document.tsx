import path from 'node:path'
import { Document, Page, View, Text, StyleSheet, Font } from '@react-pdf/renderer'
import { formatDateNumeric, formatMoney } from '@/lib/utils/format'
import { amountToWords } from '@/lib/upd/amount-to-words'
import type {
  UpdSupplierSnapshot,
  UpdBuyerSnapshot,
  UpdLineSnapshot,
} from '../types'

// PT Sans (OFL) — кириллица. public/ копируется в bundle Vercel-функции,
// process.cwd() = корень функции на runtime'е.
const FONT_DIR = path.join(process.cwd(), 'public', 'fonts', 'pt-sans')
Font.register({
  family: 'PT Sans',
  fonts: [
    { src: path.join(FONT_DIR, 'PTSans-Regular.ttf') },
    { src: path.join(FONT_DIR, 'PTSans-Bold.ttf'), fontWeight: 'bold' },
  ],
})
// Юр-документ: переносы по слогам недопустимы.
Font.registerHyphenationCallback((word) => [word])

export interface UpdPdfDocData {
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

const COPY_LABEL_SELLER = 'ЭКЗЕМПЛЯР 1 (ДЛЯ ПРОДАВЦА, ВОЗВРАЩАЕТСЯ ПОДПИСАННЫМ)'
const COPY_LABEL_BUYER = 'ЭКЗЕМПЛЯР 2 (ДЛЯ ПОКУПАТЕЛЯ)'

// A4 landscape: 842 x 595 pt. Page padding 22pt ≈ 7.75mm → полезных ~798x551.
const styles = StyleSheet.create({
  page: {
    fontFamily: 'PT Sans',
    fontSize: 8.5,
    color: '#000',
    paddingTop: 22,
    paddingBottom: 30,
    paddingHorizontal: 22,
  },

  copyLabel: {
    textAlign: 'center',
    fontSize: 8,
    color: '#555',
    marginBottom: 2,
  },
  title: {
    textAlign: 'center',
    fontSize: 13,
    fontWeight: 'bold',
    marginBottom: 1,
  },
  status: {
    textAlign: 'center',
    fontSize: 8,
    color: '#555',
    marginBottom: 6,
  },
  invoiceLine: {
    textAlign: 'center',
    fontSize: 10,
    fontWeight: 'bold',
    paddingVertical: 4,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#888',
    marginBottom: 8,
  },

  partyRow: {
    flexDirection: 'row',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderTopWidth: 1,
    borderColor: '#bbb',
  },
  partyRowLast: {
    borderBottomWidth: 1,
  },
  partyLabel: {
    width: '20%',
    padding: 3,
    backgroundColor: '#f3f3f3',
    fontWeight: 'bold',
    borderRightWidth: 1,
    borderColor: '#bbb',
  },
  partyValue: {
    width: '80%',
    padding: 3,
  },
  muted: { color: '#555' },

  linesTable: { marginTop: 8 },
  linesHeader: {
    flexDirection: 'row',
    backgroundColor: '#f3f3f3',
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: '#bbb',
    fontWeight: 'bold',
  },
  linesRow: {
    flexDirection: 'row',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#bbb',
  },
  totalsRow: {
    flexDirection: 'row',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderTopWidth: 1.5,
    borderColor: '#666',
    fontWeight: 'bold',
  },
  // 4+34+7+7+9+10+8+10+11 = 100
  cNum: { width: '4%', padding: 2, textAlign: 'center', borderRightWidth: 1, borderColor: '#bbb' },
  cName: { width: '34%', padding: 2, borderRightWidth: 1, borderColor: '#bbb' },
  cQty: { width: '7%', padding: 2, textAlign: 'right', borderRightWidth: 1, borderColor: '#bbb' },
  cUnit: { width: '7%', padding: 2, borderRightWidth: 1, borderColor: '#bbb' },
  cPrice: { width: '9%', padding: 2, textAlign: 'right', borderRightWidth: 1, borderColor: '#bbb' },
  cWithoutVat: { width: '10%', padding: 2, textAlign: 'right', borderRightWidth: 1, borderColor: '#bbb' },
  cRate: { width: '8%', padding: 2, textAlign: 'center', borderRightWidth: 1, borderColor: '#bbb' },
  cVat: { width: '10%', padding: 2, textAlign: 'right', borderRightWidth: 1, borderColor: '#bbb' },
  cWithVat: { width: '11%', padding: 2, textAlign: 'right' },
  // Колонка "Итого:" растянута на первые 5 ячеек (4+34+7+7+9 = 61%)
  cTotalsLabel: { width: '61%', padding: 2, textAlign: 'right', borderRightWidth: 1, borderColor: '#bbb' },

  totalsBlock: { marginTop: 8 },
  totalsLine: { marginBottom: 1 },
  totalsBold: { fontWeight: 'bold' },
  amountWords: { fontStyle: 'italic', marginTop: 3 },

  signaturesRow: { flexDirection: 'row', marginTop: 14 },
  signatureCol: { width: '50%', paddingRight: 12 },
  sigLabel: { fontWeight: 'bold', marginBottom: 4 },
  sigLine: { borderBottomWidth: 1, borderColor: '#333', height: 16, marginBottom: 3 },
  sigSub: { color: '#555', fontSize: 8 },

  footer: {
    position: 'absolute',
    bottom: 14,
    left: 22,
    right: 22,
    fontSize: 7,
    textAlign: 'center',
    color: '#999',
  },
})

function PartyRow({
  label,
  children,
  last,
}: {
  label: string
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <View style={last ? [styles.partyRow, styles.partyRowLast] : styles.partyRow}>
      <View style={styles.partyLabel}>
        <Text>{label}</Text>
      </View>
      <View style={styles.partyValue}>{children}</View>
    </View>
  )
}

function Copy({ doc, copyLabel }: { doc: UpdPdfDocData; copyLabel: string }) {
  const { supplier, buyer, lines } = doc
  const totalNum = parseFloat(doc.totalAmount)
  const rub = Math.trunc(totalNum)
  const kop = Math.round((totalNum - rub) * 100)

  const partiesRows: React.ReactNode[] = [
    <PartyRow key="seller" label="Продавец">
      <Text>{supplier.fullName}</Text>
      <Text style={styles.muted}>{supplier.legalAddress}</Text>
      <Text style={styles.muted}>
        ИНН {supplier.inn}
        {supplier.kpp ? ` / КПП ${supplier.kpp}` : ''} · ОГРН
        {supplier.entityType === 'INDIVIDUAL_ENTREPRENEUR' ? 'ИП' : ''} {supplier.ogrn}
      </Text>
    </PartyRow>,
    <PartyRow key="shipper" label="Грузоотправитель">
      <Text>он же</Text>
    </PartyRow>,
    <PartyRow key="consignee" label="Грузополучатель">
      <Text>{buyer.legalName ?? buyer.clientName}</Text>
      <Text style={styles.muted}>
        {buyer.locationName} · {buyer.locationAddress}
      </Text>
    </PartyRow>,
    <PartyRow key="buyer" label="Покупатель">
      <Text>{buyer.legalName ?? buyer.clientName}</Text>
      {buyer.legalAddress ? <Text style={styles.muted}>{buyer.legalAddress}</Text> : null}
      {buyer.inn ? (
        <Text style={styles.muted}>
          ИНН {buyer.inn}
          {buyer.kpp ? ` / КПП ${buyer.kpp}` : ''}
          {buyer.ogrn ? ` · ОГРН ${buyer.ogrn}` : ''}
        </Text>
      ) : null}
    </PartyRow>,
  ]
  if (buyer.contractNumber || buyer.contractDateIso) {
    partiesRows.push(
      <PartyRow key="contract" label="Основание">
        <Text>
          Договор{buyer.contractNumber ? ` № ${buyer.contractNumber}` : ''}
          {buyer.contractDateIso
            ? ` от ${formatDateNumeric(new Date(buyer.contractDateIso))}`
            : ''}
        </Text>
      </PartyRow>
    )
  }
  partiesRows.push(
    <PartyRow key="seller-bank" label="Банк продавца">
      <Text style={styles.muted}>
        {supplier.bankName} · р/с {supplier.bankAccount} · к/с {supplier.bankCorrAccount} · БИК{' '}
        {supplier.bankBic}
      </Text>
    </PartyRow>
  )
  if (buyer.bankName) {
    partiesRows.push(
      <PartyRow key="buyer-bank" label="Банк покупателя">
        <Text style={styles.muted}>
          {buyer.bankName}
          {buyer.bankAccount ? ` · р/с ${buyer.bankAccount}` : ''}
          {buyer.bankCorrAccount ? ` · к/с ${buyer.bankCorrAccount}` : ''}
          {buyer.bankBic ? ` · БИК ${buyer.bankBic}` : ''}
        </Text>
      </PartyRow>
    )
  }
  // Маркируем последнюю строку — нужна нижняя граница таблицы.
  const lastIdx = partiesRows.length - 1
  partiesRows[lastIdx] = (
    <PartyRow
      key={(partiesRows[lastIdx] as React.ReactElement).key ?? 'last'}
      label={((partiesRows[lastIdx] as React.ReactElement).props as { label: string }).label}
      last
    >
      {((partiesRows[lastIdx] as React.ReactElement).props as { children: React.ReactNode }).children}
    </PartyRow>
  )

  return (
    <>
      <Text style={styles.copyLabel}>{copyLabel}</Text>
      <Text style={styles.title}>Универсальный передаточный документ</Text>
      <Text style={styles.status}>
        Статус: 1 — счёт-фактура и передаточный документ
      </Text>
      <Text style={styles.invoiceLine}>
        Счёт-фактура № {doc.documentNumber} от {formatDateNumeric(doc.deliveryDate)}
      </Text>

      <View>{partiesRows}</View>

      <View style={styles.linesTable}>
        <View style={styles.linesHeader}>
          <Text style={styles.cNum}>№</Text>
          <Text style={styles.cName}>Наименование</Text>
          <Text style={styles.cQty}>Кол-во</Text>
          <Text style={styles.cUnit}>Ед.</Text>
          <Text style={styles.cPrice}>Цена</Text>
          <Text style={styles.cWithoutVat}>Без НДС</Text>
          <Text style={styles.cRate}>Ставка</Text>
          <Text style={styles.cVat}>Сумма НДС</Text>
          <Text style={styles.cWithVat}>С НДС</Text>
        </View>
        {lines.map((l, idx) => (
          <View key={l.orderId} style={styles.linesRow}>
            <Text style={styles.cNum}>{idx + 1}</Text>
            <Text style={styles.cName}>
              Реализация готовых обедов ({l.mealLabel}),{' '}
              {formatDateNumeric(new Date(l.deliveryDateIso))}
            </Text>
            <Text style={styles.cQty}>{l.portions}</Text>
            <Text style={styles.cUnit}>порц.</Text>
            <Text style={styles.cPrice}>{l.pricePerPortion}</Text>
            <Text style={styles.cWithoutVat}>{l.lineTotalWithoutVat}</Text>
            <Text style={styles.cRate}>{doc.vatRate ? `${doc.vatRate}%` : 'Без НДС'}</Text>
            <Text style={styles.cVat}>{l.lineVat ?? '—'}</Text>
            <Text style={styles.cWithVat}>{l.lineTotal}</Text>
          </View>
        ))}
        <View style={styles.totalsRow}>
          <Text style={styles.cTotalsLabel}>Итого:</Text>
          <Text style={styles.cWithoutVat}>{doc.amountWithoutVat}</Text>
          <Text style={styles.cRate}></Text>
          <Text style={styles.cVat}>{doc.vatAmount ?? '—'}</Text>
          <Text style={styles.cWithVat}>{doc.totalAmount}</Text>
        </View>
      </View>

      <View style={styles.totalsBlock}>
        <Text style={styles.totalsLine}>
          <Text style={styles.totalsBold}>Всего к оплате: </Text>
          {formatMoney(doc.totalAmount, { withKopecks: true })} ₽
        </Text>
        <Text style={styles.totalsLine}>
          {doc.vatRate
            ? `в т.ч. НДС ${doc.vatRate}%: ${formatMoney(doc.vatAmount ?? '0', { withKopecks: true })} ₽`
            : 'Без НДС'}
        </Text>
        <Text style={styles.amountWords}>Сумма прописью: {amountToWords(rub, kop)}</Text>
      </View>

      <View style={styles.signaturesRow}>
        <View style={styles.signatureCol}>
          <Text style={styles.sigLabel}>Товар (груз) передал:</Text>
          <View style={styles.sigLine} />
          <Text style={styles.sigSub}>
            {supplier.directorPosition} {supplier.directorName}
          </Text>
          <Text style={[styles.sigSub, { marginTop: 6 }]}>
            Дата отгрузки: {formatDateNumeric(doc.deliveryDate)}
          </Text>
          <Text style={[styles.sigSub, { marginTop: 4 }]}>М.П.</Text>
        </View>
        <View style={styles.signatureCol}>
          <Text style={styles.sigLabel}>Товар (груз) получил:</Text>
          <View style={styles.sigLine} />
          <Text style={styles.sigSub}>должность / Ф. И. О.</Text>
          <Text style={[styles.sigSub, { marginTop: 6 }]}>
            Дата получения: ___________________
          </Text>
          <Text style={[styles.sigSub, { marginTop: 4 }]}>М.П.</Text>
        </View>
      </View>

      <Text style={styles.footer} fixed>
        {copyLabel}. Сформировано Будни CRM
      </Text>
    </>
  )
}

export function UpdPdfDocument({ docs }: { docs: UpdPdfDocData[] }) {
  return (
    <Document>
      {docs.flatMap((d) => [
        <Page key={`${d.documentNumber}-1`} size="A4" orientation="landscape" style={styles.page}>
          <Copy doc={d} copyLabel={COPY_LABEL_SELLER} />
        </Page>,
        <Page key={`${d.documentNumber}-2`} size="A4" orientation="landscape" style={styles.page}>
          <Copy doc={d} copyLabel={COPY_LABEL_BUYER} />
        </Page>,
      ])}
    </Document>
  )
}
