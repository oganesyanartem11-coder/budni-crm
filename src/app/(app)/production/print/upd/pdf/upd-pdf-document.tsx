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
// process.cwd() = корень функции на runtime'е. Italic-начертание НЕ
// зарегистрировано — fontStyle:'italic' использовать нельзя (рендер падает 500).
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

const COPY_LABEL_SELLER = 'Экземпляр 1 (для продавца)'
const COPY_LABEL_BUYER = 'Экземпляр 2 (для покупателя)'

const POSTANOVLENIE =
  'Приложение № 1 к постановлению Правительства Российской Федерации от 26 декабря 2011 г. № 1137 (в редакции постановления Правительства Российской Федерации от 23 января 2026 г. № 26)'

const MONTH_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
] as const

// Ширины колонок таблицы в процентах. Сумма = 100.
const COL = {
  codeTRU: '4%',
  no: '3%',
  name: '22%',
  codeKind: '4%',
  unitGroup: '7%',
  qty: '5%',
  price: '6%',
  totalWithoutVat: '7%',
  excise: '5%',
  rate: '5%',
  vat: '7%',
  totalWithVat: '7%',
  countryGroup: '10%',
  customs: '8%',
} as const

const C_BORDER = '#999'
const C_LIGHT = '#777'

const styles = StyleSheet.create({
  page: {
    fontFamily: 'PT Sans',
    fontSize: 7.5,
    color: '#000',
    paddingTop: 16,
    paddingBottom: 24,
    paddingHorizontal: 16,
  },

  postanovlenie: {
    fontSize: 6,
    color: C_LIGHT,
    textAlign: 'right',
    marginBottom: 4,
  },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  title: {
    flexGrow: 1,
    fontSize: 13,
    fontWeight: 'bold',
  },
  statusBox: {
    borderWidth: 0.7,
    borderColor: C_BORDER,
    padding: 3,
    width: 240,
  },
  statusBoxTitle: {
    fontSize: 8,
    fontWeight: 'bold',
    marginBottom: 1,
  },
  statusBoxBody: {
    fontSize: 6.5,
    color: C_LIGHT,
  },

  invoiceLine: {
    fontSize: 9.5,
    fontWeight: 'bold',
    marginTop: 1,
  },
  correctionLine: {
    fontSize: 8,
    marginBottom: 4,
  },
  fieldNum: {
    color: C_LIGHT,
    fontSize: 6.5,
  },

  partiesRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  partyColLeft: {
    width: '50%',
    paddingRight: 4,
  },
  partyColRight: {
    width: '50%',
    paddingLeft: 4,
  },
  partyLine: {
    fontSize: 7.5,
    marginBottom: 1,
  },

  table: {
    marginTop: 2,
    borderTopWidth: 0.7,
    borderLeftWidth: 0.7,
    borderRightWidth: 0.7,
    borderBottomWidth: 0.7,
    borderColor: C_BORDER,
  },
  thRow: {
    flexDirection: 'row',
    backgroundColor: '#f3f3f3',
    borderBottomWidth: 0.5,
    borderColor: C_BORDER,
    minHeight: 42,
  },
  thWrap: {
    borderRightWidth: 0.5,
    borderColor: C_BORDER,
    padding: 2,
    justifyContent: 'space-between',
  },
  thWrapLast: {
    padding: 2,
    justifyContent: 'space-between',
  },
  thGroupWrap: {
    borderRightWidth: 0.5,
    borderColor: C_BORDER,
  },
  thGroupLabel: {
    fontSize: 5.8,
    fontWeight: 'bold',
    textAlign: 'center',
    padding: 2,
    borderBottomWidth: 0.5,
    borderColor: C_BORDER,
  },
  thSubRow: {
    flexDirection: 'row',
    flexGrow: 1,
  },
  thSubWrap: {
    borderRightWidth: 0.5,
    borderColor: C_BORDER,
    padding: 2,
    justifyContent: 'space-between',
  },
  thSubWrapLast: {
    padding: 2,
    justifyContent: 'space-between',
  },
  thLabel: {
    fontSize: 5.8,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  thNum: {
    fontSize: 5.5,
    color: C_LIGHT,
    textAlign: 'center',
  },

  tdRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderColor: C_BORDER,
  },
  td: {
    fontSize: 7,
    padding: 2,
    borderRightWidth: 0.5,
    borderColor: C_BORDER,
  },
  tdLast: {
    fontSize: 7,
    padding: 2,
  },
  tdGroup: {
    flexDirection: 'row',
    borderRightWidth: 0.5,
    borderColor: C_BORDER,
  },
  tdGroupLast: {
    flexDirection: 'row',
  },
  tdSub: {
    fontSize: 7,
    padding: 2,
    borderRightWidth: 0.5,
    borderColor: C_BORDER,
  },
  tdSubLast: {
    fontSize: 7,
    padding: 2,
  },
  center: { textAlign: 'center' },
  right: { textAlign: 'right' },
  bold: { fontWeight: 'bold' },

  totalsRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderColor: C_BORDER,
    backgroundColor: '#fafafa',
  },
  totalsLabel: {
    width: '51%',
    fontSize: 7,
    fontWeight: 'bold',
    padding: 2,
    textAlign: 'right',
    borderRightWidth: 0.5,
    borderColor: C_BORDER,
  },

  pagesNote: {
    fontSize: 7,
    marginTop: 4,
  },
  amountWords: {
    fontWeight: 'bold',
    fontSize: 8,
    marginTop: 3,
    marginBottom: 4,
  },

  sigBlock: { marginTop: 4 },
  sigSidesRow: { flexDirection: 'row' },
  sigSideLeft: { width: '50%', paddingRight: 6 },
  sigSideRight: { width: '50%', paddingLeft: 6, borderLeftWidth: 0.5, borderColor: C_BORDER },
  sigGroupLabel: {
    fontSize: 7,
    fontWeight: 'bold',
    marginTop: 4,
    marginBottom: 1,
  },
  sigCaption: {
    fontSize: 6,
    color: C_LIGHT,
    marginBottom: 1,
  },
  sigInlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginVertical: 1,
    fontSize: 7,
  },
  sigSlash: { fontSize: 7, paddingHorizontal: 2 },
  sigLine: {
    borderBottomWidth: 0.5,
    borderColor: '#444',
    height: 10,
    marginHorizontal: 2,
  },
  sigText: { fontSize: 7 },
  sigSmallNote: { fontSize: 6.5, marginTop: 2 },
  mp: { marginTop: 6, fontSize: 7, fontWeight: 'bold' },

  footer: {
    position: 'absolute',
    bottom: 8,
    left: 16,
    right: 16,
    fontSize: 6,
    textAlign: 'center',
    color: C_LIGHT,
  },
})

function FieldLine({ text, num }: { text: string; num: string }) {
  return (
    <Text style={styles.partyLine}>
      {text} <Text style={styles.fieldNum}>{num}</Text>
    </Text>
  )
}

function PenLine({ width }: { width: number | string }) {
  return <View style={[styles.sigLine, { width }]} />
}

function dayMonthYear(d: Date): { day: string; month: string; year: string } {
  return {
    day: String(d.getUTCDate()).padStart(2, '0'),
    month: MONTH_GENITIVE[d.getUTCMonth()],
    year: String(d.getUTCFullYear()),
  }
}

function baseLineText(b: UpdBuyerSnapshot): string {
  if (b.contractNumber) {
    const tail = b.contractDateIso
      ? ' от ' + formatDateNumeric(new Date(b.contractDateIso))
      : ''
    return `Договор № ${b.contractNumber}${tail}`
  }
  return 'Основной договор'
}

function Copy({ doc, copyLabel }: { doc: UpdPdfDocData; copyLabel: string }) {
  const { supplier, buyer, lines } = doc

  const totalNum = parseFloat(doc.totalAmount)
  const rub = Math.trunc(totalNum)
  const kop = Math.round((totalNum - rub) * 100)

  const innKppSupplier = `${supplier.inn}${supplier.kpp ? '/' + supplier.kpp : ''}`
  const innKppBuyer = buyer.inn
    ? `${buyer.inn}${buyer.kpp ? '/' + buyer.kpp : ''}`
    : '--'

  const buyerLegal = buyer.legalName ?? buyer.clientName
  const buyerAddr = buyer.legalAddress ?? '--'
  const consignee = `${buyerLegal}; ${buyer.locationName}, ${buyer.locationAddress}`

  const dateNumeric = formatDateNumeric(doc.deliveryDate)
  const { day, month, year } = dayMonthYear(doc.deliveryDate)

  const isIE = supplier.entityType === 'INDIVIDUAL_ENTREPRENEUR'
  const sellerHeadTitle = isIE
    ? 'Индивидуальный предприниматель'
    : 'Руководитель организации или иное уполномоченное лицо'

  const rateText = doc.vatRate ? `${doc.vatRate}%` : 'Без НДС'

  return (
    <>
      <Text style={styles.postanovlenie}>{POSTANOVLENIE}</Text>

      <View style={styles.titleRow}>
        <Text style={styles.title}>Универсальный передаточный документ</Text>
        <View style={styles.statusBox}>
          <Text style={styles.statusBoxTitle}>Статус: 1</Text>
          <Text style={styles.statusBoxBody}>
            1 — счёт-фактура и передаточный документ (акт){'\n'}
            2 — передаточный документ (акт)
          </Text>
        </View>
      </View>

      <Text style={styles.invoiceLine}>
        Счёт-фактура № {doc.documentNumber} от {dateNumeric}{' '}
        <Text style={styles.fieldNum}>(1)</Text>
      </Text>
      <Text style={styles.correctionLine}>
        Исправление № -- от -- <Text style={styles.fieldNum}>(1а)</Text>
      </Text>

      <View style={styles.partiesRow}>
        <View style={styles.partyColLeft}>
          <FieldLine text={`Продавец: ${supplier.fullName}`} num="(2)" />
          <FieldLine text={`Адрес: ${supplier.legalAddress}`} num="(2а)" />
          <FieldLine text={`ИНН/КПП продавца: ${innKppSupplier}`} num="(2б)" />
          <FieldLine text={'Грузоотправитель и его адрес: он же'} num="(3)" />
          <FieldLine text={`Грузополучатель и его адрес: ${consignee}`} num="(4)" />
          <FieldLine text={'К платёжно-расчётному документу № -- от --'} num="(5)" />
          <FieldLine
            text={`Документ об отгрузке: Универсальный передаточный документ № ${doc.documentNumber} от ${dateNumeric}`}
            num="(5а)"
          />
        </View>
        <View style={styles.partyColRight}>
          <FieldLine text={`Покупатель: ${buyerLegal}`} num="(6)" />
          <FieldLine text={`Адрес: ${buyerAddr}`} num="(6а)" />
          <FieldLine text={`ИНН/КПП покупателя: ${innKppBuyer}`} num="(6б)" />
          <FieldLine text={'Валюта: наименование, код Российский рубль, 643'} num="(7)" />
          <FieldLine
            text={'Идентификатор государственного контракта, договора (соглашения) (при наличии): --'}
            num="(8)"
          />
        </View>
      </View>

      {/* Таблица позиций */}
      <View style={styles.table}>
        {/* Шапка таблицы */}
        <View style={styles.thRow}>
          <View style={[styles.thWrap, { width: COL.codeTRU }]}>
            <Text style={styles.thLabel}>Код товара/работ услуг</Text>
            <Text style={styles.thNum}>А</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.no }]}>
            <Text style={styles.thLabel}>№ п/п</Text>
            <Text style={styles.thNum}>1</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.name }]}>
            <Text style={styles.thLabel}>
              Наименование товара (описание работ, услуг), имущественного права
            </Text>
            <Text style={styles.thNum}>1а</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.codeKind }]}>
            <Text style={styles.thLabel}>Код вида товара</Text>
            <Text style={styles.thNum}>1б</Text>
          </View>
          {/* Единица измерения — двухуровневый заголовок */}
          <View style={[styles.thGroupWrap, { width: COL.unitGroup }]}>
            <Text style={styles.thGroupLabel}>Единица измерения</Text>
            <View style={styles.thSubRow}>
              <View style={[styles.thSubWrap, { width: '43%' }]}>
                <Text style={styles.thLabel}>код</Text>
                <Text style={styles.thNum}>2</Text>
              </View>
              <View style={[styles.thSubWrapLast, { width: '57%' }]}>
                <Text style={styles.thLabel}>условное обозначение (национальное)</Text>
                <Text style={styles.thNum}>2а</Text>
              </View>
            </View>
          </View>
          <View style={[styles.thWrap, { width: COL.qty }]}>
            <Text style={styles.thLabel}>Количество (объём)</Text>
            <Text style={styles.thNum}>3</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.price }]}>
            <Text style={styles.thLabel}>Цена (тариф) за единицу измерения</Text>
            <Text style={styles.thNum}>4</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.totalWithoutVat }]}>
            <Text style={styles.thLabel}>
              Стоимость товаров (работ, услуг) без налога — всего
            </Text>
            <Text style={styles.thNum}>5</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.excise }]}>
            <Text style={styles.thLabel}>В том числе сумма акциза</Text>
            <Text style={styles.thNum}>6</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.rate }]}>
            <Text style={styles.thLabel}>Налоговая ставка</Text>
            <Text style={styles.thNum}>7</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.vat }]}>
            <Text style={styles.thLabel}>
              Сумма налога, предъявляемая покупателю
            </Text>
            <Text style={styles.thNum}>8</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.totalWithVat }]}>
            <Text style={styles.thLabel}>
              Стоимость товаров (работ, услуг) с налогом — всего
            </Text>
            <Text style={styles.thNum}>9</Text>
          </View>
          {/* Страна происхождения — двухуровневый заголовок */}
          <View style={[styles.thGroupWrap, { width: COL.countryGroup }]}>
            <Text style={styles.thGroupLabel}>Страна происхождения товара</Text>
            <View style={styles.thSubRow}>
              <View style={[styles.thSubWrap, { width: '40%' }]}>
                <Text style={styles.thLabel}>цифровой код</Text>
                <Text style={styles.thNum}>10</Text>
              </View>
              <View style={[styles.thSubWrapLast, { width: '60%' }]}>
                <Text style={styles.thLabel}>краткое наименование</Text>
                <Text style={styles.thNum}>10а</Text>
              </View>
            </View>
          </View>
          <View style={[styles.thWrapLast, { width: COL.customs }]}>
            <Text style={styles.thLabel}>
              Регистрационный номер декларации на товары / партии товара
            </Text>
            <Text style={styles.thNum}>11</Text>
          </View>
        </View>

        {/* Строки данных */}
        {lines.map((l, idx) => (
          <View key={l.orderId} style={styles.tdRow}>
            <Text style={[styles.td, styles.center, { width: COL.codeTRU }]}>--</Text>
            <Text style={[styles.td, styles.center, { width: COL.no }]}>{idx + 1}</Text>
            <Text style={[styles.td, { width: COL.name }]}>
              Реализация готовых обедов ({l.mealLabel}),{' '}
              {formatDateNumeric(new Date(l.deliveryDateIso))}
            </Text>
            <Text style={[styles.td, styles.center, { width: COL.codeKind }]}>--</Text>
            <View style={[styles.tdGroup, { width: COL.unitGroup }]}>
              <Text style={[styles.tdSub, styles.center, { width: '43%' }]}>796</Text>
              <Text style={[styles.tdSubLast, styles.center, { width: '57%' }]}>шт</Text>
            </View>
            <Text style={[styles.td, styles.right, { width: COL.qty }]}>{l.portions}</Text>
            <Text style={[styles.td, styles.right, { width: COL.price }]}>
              {l.pricePerPortion}
            </Text>
            <Text style={[styles.td, styles.right, { width: COL.totalWithoutVat }]}>
              {l.lineTotalWithoutVat}
            </Text>
            <Text style={[styles.td, styles.center, { width: COL.excise }]}>
              Без акциза
            </Text>
            <Text style={[styles.td, styles.center, { width: COL.rate }]}>
              {rateText}
            </Text>
            <Text style={[styles.td, styles.right, { width: COL.vat }]}>
              {l.lineVat ?? '--'}
            </Text>
            <Text style={[styles.td, styles.right, { width: COL.totalWithVat }]}>
              {l.lineTotal}
            </Text>
            <View style={[styles.tdGroup, { width: COL.countryGroup }]}>
              <Text style={[styles.tdSub, styles.center, { width: '40%' }]}>--</Text>
              <Text style={[styles.tdSubLast, styles.center, { width: '60%' }]}>--</Text>
            </View>
            <Text style={[styles.tdLast, styles.center, { width: COL.customs }]}>--</Text>
          </View>
        ))}

        {/* Строка "Всего к оплате (9)" */}
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>
            Всего к оплате <Text style={styles.fieldNum}>(9)</Text>
          </Text>
          <Text style={[styles.td, styles.right, styles.bold, { width: COL.totalWithoutVat }]}>
            {doc.amountWithoutVat}
          </Text>
          <Text style={[styles.td, styles.center, { width: COL.excise }]}>Х</Text>
          <Text style={[styles.td, styles.center, { width: COL.rate }]}>Х</Text>
          <Text style={[styles.td, styles.right, styles.bold, { width: COL.vat }]}>
            {doc.vatAmount ?? 'Х'}
          </Text>
          <Text style={[styles.td, styles.right, styles.bold, { width: COL.totalWithVat }]}>
            {doc.totalAmount}
          </Text>
          <Text style={[styles.td, styles.center, { width: COL.countryGroup }]}>Х</Text>
          <Text style={[styles.tdLast, styles.center, { width: COL.customs }]}>Х</Text>
        </View>
      </View>

      <Text style={styles.pagesNote}>Документ составлен на ___ листе</Text>

      <Text style={styles.amountWords}>
        Всего к оплате прописью: {amountToWords(rub, kop)} ({formatMoney(doc.totalAmount, { withKopecks: true })} ₽)
      </Text>

      {/* Подписи: две стороны */}
      <View style={styles.sigBlock}>
        <View style={styles.sigSidesRow}>
          {/* Сторона продавца */}
          <View style={styles.sigSideLeft}>
            <Text style={styles.sigGroupLabel}>{sellerHeadTitle}</Text>
            <View style={styles.sigInlineRow}>
              <PenLine width={80} />
              <Text style={styles.sigSlash}>/</Text>
              <Text style={styles.sigText}>{supplier.directorName}</Text>
            </View>
            <Text style={styles.sigCaption}>(подпись) / (ф.и.о.)</Text>
            {isIE ? (
              <Text style={styles.sigSmallNote}>
                Основной государственный регистрационный номер ИП и дата
                присвоения: ОГРНИП {supplier.ogrn}
              </Text>
            ) : null}

            <Text style={styles.sigGroupLabel}>
              Главный бухгалтер или иное уполномоченное лицо
            </Text>
            <View style={styles.sigInlineRow}>
              <PenLine width={80} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={110} />
            </View>
            <Text style={styles.sigCaption}>(подпись) / (ф.и.о.)</Text>

            <Text style={styles.sigSmallNote}>
              Основание передачи (сдачи) / получения (приёмки): {baseLineText(buyer)}{' '}
              <Text style={styles.fieldNum}>[8]</Text>
            </Text>
            <View style={styles.sigInlineRow}>
              <Text style={styles.sigText}>
                Данные о транспортировке и грузе:{' '}
              </Text>
              <PenLine width={200} />
              <Text style={styles.fieldNum}> [9]</Text>
            </View>

            <Text style={styles.sigGroupLabel}>
              Товар (груз) передал / услуги сдал <Text style={styles.fieldNum}>[10]</Text>
            </Text>
            <View style={styles.sigInlineRow}>
              <Text style={styles.sigText}>{supplier.directorPosition}</Text>
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={70} />
              <Text style={styles.sigSlash}>/</Text>
              <Text style={styles.sigText}>{supplier.directorName}</Text>
            </View>
            <Text style={styles.sigCaption}>(должность) / (подпись) / (ф.и.о.)</Text>

            <Text style={styles.sigSmallNote}>
              Дата отгрузки, передачи (сдачи) « {day} » {month} {year} года{' '}
              <Text style={styles.fieldNum}>[11]</Text>
            </Text>

            <Text style={styles.sigGroupLabel}>
              Ответственный за правильность оформления факта хозяйственной жизни{' '}
              <Text style={styles.fieldNum}>[13]</Text>
            </Text>
            <View style={styles.sigInlineRow}>
              <PenLine width={70} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={60} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={90} />
            </View>
            <Text style={styles.sigCaption}>(должность) / (подпись) / (ф.и.о.)</Text>

            <Text style={styles.sigSmallNote}>
              Наименование экономического субъекта — составителя документа{' '}
              <Text style={styles.fieldNum}>[14]</Text>: {supplier.fullName}, ИНН{' '}
              {innKppSupplier}
            </Text>

            <Text style={styles.mp}>М.П.</Text>
          </View>

          {/* Сторона покупателя */}
          <View style={styles.sigSideRight}>
            <Text style={styles.sigGroupLabel}>
              Руководитель организации или иное уполномоченное лицо
            </Text>
            <View style={styles.sigInlineRow}>
              <PenLine width={80} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={110} />
            </View>
            <Text style={styles.sigCaption}>(подпись) / (ф.и.о.)</Text>

            <Text style={styles.sigGroupLabel}>
              Главный бухгалтер или иное уполномоченное лицо
            </Text>
            <View style={styles.sigInlineRow}>
              <PenLine width={80} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={110} />
            </View>
            <Text style={styles.sigCaption}>(подпись) / (ф.и.о.)</Text>

            <Text style={styles.sigGroupLabel}>
              Товар (груз) получил / услуги принял <Text style={styles.fieldNum}>[15]</Text>
            </Text>
            <View style={styles.sigInlineRow}>
              <PenLine width={70} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={60} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={90} />
            </View>
            <Text style={styles.sigCaption}>(должность) / (подпись) / (ф.и.о.)</Text>

            <Text style={styles.sigSmallNote}>
              Дата получения (приёмки) « __ » __________ 20__ года{' '}
              <Text style={styles.fieldNum}>[16]</Text>
            </Text>

            <Text style={styles.sigGroupLabel}>
              Ответственный за правильность оформления факта хозяйственной жизни{' '}
              <Text style={styles.fieldNum}>[18]</Text>
            </Text>
            <View style={styles.sigInlineRow}>
              <PenLine width={70} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={60} />
              <Text style={styles.sigSlash}>/</Text>
              <PenLine width={90} />
            </View>
            <Text style={styles.sigCaption}>(должность) / (подпись) / (ф.и.о.)</Text>

            <Text style={styles.sigSmallNote}>
              Наименование экономического субъекта — составителя документа{' '}
              <Text style={styles.fieldNum}>[19]</Text>: {buyerLegal}
              {buyer.inn ? ', ИНН ' + buyer.inn : ''}
            </Text>

            <Text style={styles.mp}>М.П.</Text>
          </View>
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
        <Page
          key={`${d.documentNumber}-1`}
          size="A4"
          orientation="landscape"
          style={styles.page}
        >
          <Copy doc={d} copyLabel={COPY_LABEL_SELLER} />
        </Page>,
        <Page
          key={`${d.documentNumber}-2`}
          size="A4"
          orientation="landscape"
          style={styles.page}
        >
          <Copy doc={d} copyLabel={COPY_LABEL_BUYER} />
        </Page>,
      ])}
    </Document>
  )
}
